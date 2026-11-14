
const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");

const Mandate = require("../models/Mandate");
const MandateRun = require("../models/MandateRun");
const User = require("../models/User");
const { transferMoney } = require("../services/money");

const router = express.Router();

function getIndiaDay() {
  return new Date(Date.now() + 330 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function isValidDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const date = new Date(`${value}T00:00:00.000Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function addOneMonth(day) {
  const [year, month, date] = day.split("-").map(Number);

  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;

  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-${String(
    date
  ).padStart(2, "0")}`;
}

function daysLate(dueDay, today) {
  const due = new Date(`${dueDay}T00:00:00.000Z`);
  const current = new Date(`${today}T00:00:00.000Z`);

  return Math.floor((current - due) / 86400000);
}

// Protect cron endpoint using CRON_SECRET.
router.use((req, res, next) => {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.get("authorization");

  if (!secret || !authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized cron request" });
  }

  const supplied = Buffer.from(authHeader.slice(7));
  const expected = Buffer.from(secret);

  if (
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(supplied, expected)
  ) {
    return res.status(401).json({ error: "Unauthorized cron request" });
  }

  next();
});

// Process due AutoPay mandates.
router.get("/autopay", async (req, res) => {
  const timeTravelEnabled =
    process.env.ALLOW_TIME_TRAVEL === "true";

  let today = getIndiaDay();

  if (req.query.date !== undefined) {
    if (!timeTravelEnabled) {
      return res.status(400).json({ error: "Time travel is off" });
    }

    if (!isValidDay(req.query.date)) {
      return res.status(400).json({ error: "Invalid date format" });
    }

    today = req.query.date;
  }

  const summary = {
    date: today,
    processed: 0,
    successful: 0,
    failed: 0,
    missed: 0,
    skipped: 0,
    errors: [],
    more: false,
  };

  try {
    const mandates = await Mandate.find({
      status: "ACTIVE",
      nextRunDay: { $lte: today },
    })
      .sort({ nextRunDay: 1, createdAt: 1 })
      .limit(50)
      .select("_id nextRunDay");

    for (const item of mandates) {
      const dueDay = item.nextRunDay;

      try {
        // Payments more than 3 days late are marked MISSED.
        if (daysLate(dueDay, today) > 3) {
          const session = await mongoose.startSession();

          try {
            await session.withTransaction(async () => {
              const claimed = await Mandate.findOneAndUpdate(
                {
                  _id: item._id,
                  status: "ACTIVE",
                  nextRunDay: dueDay,
                },
                {
                  $set: {
                    nextRunDay: addOneMonth(dueDay),
                  },
                },
                { new: true, session }
              );

              if (!claimed) return;

              const existingRun = await MandateRun.findOne({
                mandateId: claimed._id,
                dueDay,
              }).session(session);

              if (existingRun) return;

              await MandateRun.create(
                [
                  {
                    mandateId: claimed._id,
                    dueDay,
                    status: "MISSED",
                    amount: claimed.amount,
                    reason: "Payment was more than 3 days late",
                  },
                ],
                { session }
              );
            });
          } finally {
            await session.endSession();
          }

          summary.missed++;
          summary.processed++;
          continue;
        }

        // Claim mandate and transfer money in one transaction.
        const session = await mongoose.startSession();
        let wasProcessed = false;

        try {
          await session.withTransaction(async () => {
            const claimed = await Mandate.findOneAndUpdate(
              {
                _id: item._id,
                status: "ACTIVE",
                nextRunDay: dueDay,
              },
              {
                $set: {
                  nextRunDay: addOneMonth(dueDay),
                },
              },
              { new: true, session }
            );

            if (!claimed) return;

            const existingRun = await MandateRun.findOne({
              mandateId: claimed._id,
              dueDay,
            }).session(session);

            if (existingRun) return;

            const payee = await User.findById(claimed.payeeId)
              .select("username")
              .session(session);

            if (!payee) {
              const error = new Error("AutoPay recipient not found");
              error.status = 404;
              throw error;
            }

            const payment = await transferMoney({
              fromUserId: claimed.payerId,
              to: payee.username,
              amount: claimed.amount,
              note: "AutoPay",
              idempotencyKey: `autopay:${claimed._id}:${dueDay}`,
              session,
              skipReward: true,
            });

            if (!payment || payment.status !== 200) {
              const error = new Error(
                payment?.body?.error || "AutoPay payment failed"
              );
              error.status = payment?.status || 400;
              throw error;
            }

            await MandateRun.create(
              [
                {
                  mandateId: claimed._id,
                  dueDay,
                  status: "SUCCESS",
                  amount: claimed.amount,
                  transactionId: payment.body.transactionId,
                },
              ],
              { session }
            );

            await Mandate.updateOne(
              { _id: claimed._id },
              { $set: { failedCount: 0 } },
              { session }
            );

            wasProcessed = true;
          });
        } finally {
          await session.endSession();
        }

        if (wasProcessed) {
          summary.successful++;
          summary.processed++;
        } else {
          summary.skipped++;
        }
      } catch (paymentError) {
        console.error("AutoPay payment error:", item._id, paymentError);

        // Record failure and advance the mandate in a separate transaction.
        try {
          const session = await mongoose.startSession();

          try {
            await session.withTransaction(async () => {
              const mandate = await Mandate.findOne({
                _id: item._id,
                status: "ACTIVE",
                nextRunDay: dueDay,
              }).session(session);

              if (!mandate) return;

              const existingRun = await MandateRun.findOne({
                mandateId: mandate._id,
                dueDay,
              }).session(session);

              if (existingRun) return;

              const nextFailedCount = mandate.failedCount + 1;

              await MandateRun.create(
                [
                  {
                    mandateId: mandate._id,
                    dueDay,
                    status: "FAILED",
                    amount: mandate.amount,
                    reason: String(
                      paymentError.message || "Payment failed"
                    ).slice(0, 300),
                  },
                ],
                { session }
              );

              await Mandate.updateOne(
                {
                  _id: mandate._id,
                  status: "ACTIVE",
                  nextRunDay: dueDay,
                },
                {
                  $set: {
                    nextRunDay: addOneMonth(dueDay),
                    failedCount: nextFailedCount,
                    ...(nextFailedCount >= 3
                      ? { status: "PAUSED" }
                      : {}),
                  },
                },
                { session }
              );
            });
          } finally {
            await session.endSession();
          }

          summary.failed++;
          summary.processed++;
        } catch (recordError) {
          console.error("AutoPay failure recording error:", recordError);
          summary.errors.push({
            mandateId: item._id.toString(),
            error: "Unable to record payment failure",
          });
        }
      }
    }

    const remaining = await Mandate.exists({
      status: "ACTIVE",
      nextRunDay: { $lte: today },
    });

    summary.more = Boolean(remaining);

    return res.json(summary);
  } catch (error) {
    console.error("AutoPay cron error:", error);

    return res.status(500).json({
      error: "AutoPay cron processing failed",
      summary,
    });
  }
});

module.exports = router;
