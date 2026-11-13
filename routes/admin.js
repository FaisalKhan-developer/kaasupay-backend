
const express = require("express");
const mongoose = require("mongoose");
const { z } = require("zod");

const User = require("../models/User");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const LedgerEntry = require("../models/LedgerEntry");

const router = express.Router();

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

module.exports = router;
