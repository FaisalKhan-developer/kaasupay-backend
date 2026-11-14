
const express = require("express");
const mongoose = require("mongoose");
const { z } = require("zod");

const User = require("../models/User");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const LedgerEntry = require("../models/LedgerEntry");

const router = express.Router();

const Offer = require("../models/Offer");
const { getOrCreatePromoWallet } = require("../services/promoWallet");
// ================= ADMIN AUTHENTICATION =================

function verifyAdmin(req, res, next) {
  const adminKey = process.env.ADMIN_KEY;

  if (
    !adminKey ||
    typeof req.get("x-admin-key") !== "string" ||
    req.get("x-admin-key") !== adminKey
  ) {
    return res.status(401).json({
      error: "Staff only",
    });
  }

  next();
}

// ================= DEPOSIT VALIDATION =================

const depositSchema = z.object({
  to: z.string().trim().email(),
  amount: z.number().int().min(100).max(10000000),
  note: z.string().trim().max(50).optional().default(""),
});

// ================= ADMIN DEPOSIT =================

router.post("/deposit", verifyAdmin, async (req, res) => {
  const parsed = depositSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(", "),
    });
  }

  const { to, amount, note } = parsed.data;
  const cleanedNote = note || "Bank deposit";

  let session;

  try {
    const user = await User.findOne({
      username: to.toLowerCase(),
    });

    if (!user) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    session = await mongoose.startSession();

    let result;

    await session.withTransaction(async () => {
      const wallet = await Wallet.findOneAndUpdate(
        { user: user._id },
        { $inc: { balance: amount } },
        {
          new: true,
          upsert: true,
          setDefaultsOnInsert: true,
          session,
          runValidators: true,
        }
      );

      const [transaction] = await Transaction.create(
        [
          {
            type: "DEPOSIT",
            fromUserId: null,
            toUserId: user._id,
            amount,
            note: cleanedNote,
            status: "SUCCESS",
          },
        ],
        { session }
      );

await LedgerEntry.create(
  [
    {
      userId: user._id,
      transactionId: transaction._id,
      type: "DEPOSIT",
      direction: "CREDIT",
      amount,
      balanceAfter: wallet.balance,
    },
  ],
  { session }
);

      result = {
        message: "Deposit successful",
        transactionId: transaction._id.toString(),
        to: user.username,
        amount,
        balance: wallet.balance,
      };
    });

    return res.status(201).json(result);
  } catch (error) {
    console.error("Deposit error:", error);

    return res.status(500).json({
      error: "Deposit failed. No changes were committed.",
    });
  } finally {
    if (session) {
      await session.endSession();
    }
  }
});
const offerSchema = z.object({
  code: z.string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{3,20}$/),

  percent: z.number().int().min(1).max(50),
  maxCashback: z.number().int().min(1),
  minPayment: z.number().int().min(100),
  budget: z.number().int().min(1),
  days: z.number().int().min(1).max(30),
});

// ================= ADMIN UNLOCK PAYMENT PIN =================

router.post(
  "/users/:id/unlock-pin",
  verifyAdmin,
  async (req, res) => {
    try {
      const userId = req.params.id;

      if (!mongoose.isValidObjectId(userId)) {
        return res.status(400).json({
          error: "Invalid user ID",
        });
      }

      const user = await User.findByIdAndUpdate(
        userId,
        {
          $set: {
            pinFailedCount: 0,
            pinLockedUntil: null,
          },
        },
        {
          new: true,
        }
      ).select("_id username pinHash pinLockedUntil pinFailedCount");

      if (!user) {
        return res.status(404).json({
          error: "User not found",
        });
      }

      return res.json({
        message: "Payment PIN lock has been cleared",
        user: {
          id: user._id,
          username: user.username,
          hasPin: Boolean(user.pinHash),
          pinFailedCount: user.pinFailedCount,
          pinLockedUntil: user.pinLockedUntil,
        },
      });
    } catch (error) {
      console.error("Admin PIN unlock error:", error);

      return res.status(500).json({
        error: "Unable to unlock payment PIN",
      });
    }
  }
);


router.post("/offers", verifyAdmin, async (req, res) => {
  const parsed = offerSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(", "),
    });
  }

  const { code, percent, maxCashback, minPayment, budget, days } =
    parsed.data;

  let session;

  try {
    session = await mongoose.startSession();

    let result;

    await session.withTransaction(async () => {
      const existingOffer = await Offer.findOne({ code }).session(session);

      if (existingOffer) {
        const error = new Error("Offer code already exists");
        error.status = 409;
        throw error;
      }

      const { promoUser } = await getOrCreatePromoWallet(session);

      const promoWallet = await Wallet.findOneAndUpdate(
        { user: promoUser._id },
        { $inc: { balance: budget } },
        {
          new: true,
          session,
          runValidators: true,
        }
      );

      const now = new Date();
      const endsAt = new Date(
        now.getTime() + days * 24 * 60 * 60 * 1000
      );

      const [offer] = await Offer.create(
        [
          {
            code,
            percent,
            maxCashback,
            minPayment,
            budget,
            budgetLeft: budget,
            startsAt: now,
            endsAt,
          },
        ],
        { session }
      );

      const [transaction] = await Transaction.create(
        [
          {
            type: "DEPOSIT",
            fromUserId: null,
            toUserId: promoUser._id,
            amount: budget,
            note: `Cashback offer budget: ${code}`,
            status: "SUCCESS",
          },
        ],
        { session }
      );

      await LedgerEntry.create(
        [
          {
            userId: promoUser._id,
            transactionId: transaction._id,
            type: "DEPOSIT",
            direction: "CREDIT",
            amount: budget,
            balanceAfter: promoWallet.balance,
          },
        ],
        { session }
      );

      result = {
        message: "Cashback offer created successfully",
        offer: {
          code: offer.code,
          percent: offer.percent,
          maxCashback: offer.maxCashback,
          minPayment: offer.minPayment,
          budget: offer.budget,
          budgetLeft: offer.budgetLeft,
          startsAt: offer.startsAt,
          endsAt: offer.endsAt,
        },
      };
    });

    return res.status(201).json(result);
  } catch (error) {
    console.error("Offer creation error:", error);

    return res.status(error.status || (error.code === 11000 ? 409 : 500)).json({
      error:
        error.status === 409 || error.code === 11000
          ? "Offer code already exists"
          : "Unable to create cashback offer. No changes were committed.",
    });
  } finally {
    if (session) {
      await session.endSession();
    }
  }
});

// ================= ADMIN CASHBACK OFFER REPORT =================

router.get("/offers/:code", verifyAdmin, async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();

    const offer = await Offer.findOne({ code }).lean();

    if (!offer) {
      return res.status(404).json({
        error: "Offer not found",
      });
    }

    const report = await require("../models/RewardCard").aggregate([
      {
        $match: {
          offerId: offer._id,
        },
      },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          claimedAmount: {
            $sum: {
              $cond: [
                { $eq: ["$status", "CLAIMED"] },
                "$amount",
                0,
              ],
            },
          },
        },
      },
    ]);

    const summary = {
      UNCLAIMED: 0,
      CLAIMED: 0,
      EXHAUSTED: 0,
      EXPIRED: 0,
    };

    let totalClaimed = 0;

    for (const item of report) {
      summary[item._id] = item.count;
      totalClaimed += item.claimedAmount;
    }

    return res.json({
      offer: {
        code: offer.code,
        budget: offer.budget,
        budgetLeft: offer.budgetLeft,
      },
      cards: summary,
      totalClaimed,
      budgetReconciliation: {
        expectedSpent: offer.budget - offer.budgetLeft,
        actualSpent: totalClaimed,
        matches: offer.budget - offer.budgetLeft === totalClaimed,
      },
    });
  } catch (error) {
    console.error("Offer report error:", error);

    return res.status(500).json({
      error: "Unable to fetch offer report",
    });
  }
});

module.exports = router;
