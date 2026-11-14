
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { JWT_SECRET } = require("../config");

const RewardCard = require("../models/RewardCard");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const LedgerEntry = require("../models/LedgerEntry");
const Offer = require("../models/Offer");

const { getOrCreatePromoWallet } = require("../services/promoWallet");

const router = express.Router();

// Authentication
function authenticate(req, res, next) {
  const authHeader = req.get("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Authentication required",
    });
  }

  try {
    const decoded = jwt.verify(
      authHeader.slice(7),
      JWT_SECRET
    );

    req.userId = decoded.userId;
    next();
  } catch {
    return res.status(401).json({
      error: "Invalid or expired token",
    });
  }
}

// GET /rewards
// Fetch the user's reward cards
router.get("/", authenticate, async (req, res) => {
  try {
    const now = new Date();

    // Expire old unclaimed cards
    await RewardCard.updateMany(
      {
        userId: req.userId,
        status: "UNCLAIMED",
        expiresAt: { $lte: now },
      },
      {
        $set: { status: "EXPIRED" },
      }
    );

    const cards = await RewardCard.find({
      userId: req.userId,
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const data = cards.map((card) => ({
      id: card._id,
      status: card.status,
      amount:
        card.status === "UNCLAIMED"
          ? null
          : card.amount,
      expiresAt: card.expiresAt,
      claimedAt: card.claimedAt,
      createdAt: card.createdAt,
    }));

    return res.status(200).json({ data });
  } catch (error) {
    console.error("Rewards fetch error:", error);

    return res.status(500).json({
      error: "Failed to fetch rewards",
    });
  }
});

// POST /rewards/:id/claim
// Claim a cashback reward
router.post("/:id/claim", authenticate, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({
      error: "Invalid reward card ID",
    });
  }

  const session = await mongoose.startSession();

  let outcome = null;

  try {
    await session.withTransaction(async () => {
      const card = await RewardCard.findOne({
        _id: req.params.id,
        userId: req.userId,
      }).session(session);

      if (!card) {
        outcome = {
          status: 404,
          body: { error: "Reward card not found" },
        };
        return;
      }

      if (card.status !== "UNCLAIMED") {
        outcome = {
          status: 409,
          body: {
            error: "Reward card is not available",
            status: card.status,
          },
        };
        return;
      }

      const now = new Date();

      if (card.expiresAt <= now) {
        card.status = "EXPIRED";
        await card.save({ session });

        outcome = {
          status: 200,
          body: {
            message: "Reward card has expired",
            status: "EXPIRED",
          },
        };
        return;
      }

      // Atomically reserve the offer budget
      const offer = await Offer.findOneAndUpdate(
        {
          _id: card.offerId,
          budgetLeft: { $gte: card.amount },
        },
        {
          $inc: { budgetLeft: -card.amount },
        },
        {
          new: true,
          session,
        }
      );

      if (!offer) {
        card.status = "EXHAUSTED";
        await card.save({ session });

        outcome = {
          status: 200,
          body: {
            message: "Better luck next time",
            status: "EXHAUSTED",
          },
        };
        return;
      }

      // Get company promotional wallet
      const { promoUser, promoWallet } =
        await getOrCreatePromoWallet(session);

      // Debit promotional wallet
      const updatedPromoWallet =
        await Wallet.findOneAndUpdate(
          {
            _id: promoWallet._id,
            balance: { $gte: card.amount },
          },
          {
            $inc: { balance: -card.amount },
          },
          {
            new: true,
            session,
          }
        );

      if (!updatedPromoWallet) {
        throw new Error("Insufficient promotional wallet balance");
      }

      // Credit user's wallet
      const updatedUserWallet =
        await Wallet.findOneAndUpdate(
          { user: req.userId },
          {
            $inc: { balance: card.amount },
          },
          {
            new: true,
            session,
          }
        );

      if (!updatedUserWallet) {
        throw new Error("User wallet not found");
      }

      // Create cashback transaction
      const [cashbackTransaction] =
        await Transaction.create(
          [
            {
              type: "CASHBACK",
              fromUserId: promoUser._id,
              toUserId: req.userId,
              amount: card.amount,
              note: "Cashback reward",
              status: "SUCCESS",
            },
          ],
          { session }
        );

      // Promotional wallet debit ledger entry
      await LedgerEntry.create(
        [
          {
            userId: promoUser._id,
            transactionId: cashbackTransaction._id,
            type: "CASHBACK",
            direction: "DEBIT",
            amount: card.amount,
            balanceAfter: updatedPromoWallet.balance,
          },
        ],
        { session }
      );

      // User wallet credit ledger entry
      await LedgerEntry.create(
        [
          {
            userId: req.userId,
            transactionId: cashbackTransaction._id,
            type: "CASHBACK",
            direction: "CREDIT",
            amount: card.amount,
            balanceAfter: updatedUserWallet.balance,
          },
        ],
        { session }
      );

      // Mark reward card as claimed
      card.status = "CLAIMED";
      card.cashbackTransactionId = cashbackTransaction._id;
      card.claimedAt = now;

      await card.save({ session });

      outcome = {
        status: 200,
        body: {
          message: "Cashback claimed successfully",
          status: "CLAIMED",
          amount: card.amount,
          transactionId: cashbackTransaction._id,
          walletBalance: updatedUserWallet.balance,
        },
      };
    });

    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    console.error("Cashback claim error:", error);

    return res.status(500).json({
      error: "Failed to claim cashback",
    });
  } finally {
    await session.endSession();
  }
});

module.exports = router;
