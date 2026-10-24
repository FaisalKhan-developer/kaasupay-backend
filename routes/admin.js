
const express = require("express");
const mongoose = require("mongoose");
const { z } = require("zod");

const User = require("../models/User");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const LedgerEntry = require("../models/LedgerEntry");

const router = express.Router();

const depositSchema = z.object({
  to: z.string().trim().email(),
  amount: z.number().int().min(100).max(10000000),
  note: z.string().trim().max(50).optional().default(""),
});

router.post("/deposit", async (req, res) => {
  // 1. Verify the staff key
  const adminKey = process.env.ADMIN_KEY;

  if (
    !adminKey ||
    typeof req.get("x-admin-key") !== "string" ||
    req.get("x-admin-key") !== adminKey
  ) {
    return res.status(401).json({ error: "Staff only" });
  }

  // 2. Validate request body
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
    // 3. Find recipient using the existing username field
    const user = await User.findOne({ username: to.toLowerCase() });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // 4. Update wallet and create records atomically
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

module.exports = router;
