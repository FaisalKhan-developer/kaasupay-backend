const mongoose = require("mongoose");
const crypto = require("crypto");

const User = require("../models/User");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const LedgerEntry = require("../models/LedgerEntry");
const IdempotencyRecord = require("../models/IdempotencyRecord");
const BankAccount = require("../models/bankAccount");
const Withdrawal = require("../models/Withdrawal");
const OutboxEvent = require("../models/OutboxEvent");
const DailySpend = require("../models/DailySpend");

// Daily outgoing limit: ₹10,000 = 1,000,000 paise
const DAILY_LIMIT = 1000000;

// India timezone: UTC + 5:30
function getIndiaDay() {
  const indiaTime = new Date(Date.now() + 330 * 60 * 1000);
  return indiaTime.toISOString().slice(0, 10);
}

// Reserve daily spending inside the current MongoDB transaction.
async function reserveDailySpend(userId, amount, session) {
  const day = getIndiaDay();

  // Create today's counter if it does not exist.
  await DailySpend.updateOne(
    { userId, day },
    {
      $setOnInsert: {
        spent: 0,
      },
    },
    {
      upsert: true,
      session,
    }
  );

  // Atomically increase spending only if the limit allows it.
  const updated = await DailySpend.findOneAndUpdate(
    {
      userId,
      day,
      spent: {
        $lte: DAILY_LIMIT - amount,
      },
    },
    {
      $inc: {
        spent: amount,
      },
    },
    {
      new: true,
      session,
    }
  );

  if (!updated) {
    const error = new Error(
      "Daily outgoing limit of ₹10,000 exceeded"
    );
    error.status = 400;
    throw error;
  }

  return updated;
}

// ================= TRANSFER MONEY =================

async function transferMoney({
  fromUserId,
  to,
  amount,
  note,
  idempotencyKey,
}) {
  const session = await mongoose.startSession();

  try {
    let result;

    await session.withTransaction(async () => {
      const recipient = await User.findOne({
        username: to.trim().toLowerCase(),
      }).session(session);

      if (!recipient) {
        const error = new Error("Recipient not found");
        error.status = 404;
        throw error;
      }

      if (recipient._id.toString() === fromUserId.toString()) {
        const error = new Error("Cannot transfer to yourself");
        error.status = 400;
        throw error;
      }

      const requestHash = crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            to: recipient._id.toString(),
            amount,
            note: note || "",
          })
        )
        .digest("hex");

      const existing = await IdempotencyRecord.findOne({
        userId: fromUserId,
        key: idempotencyKey,
      }).session(session);

      if (existing) {
        if (existing.requestHash !== requestHash) {
          const error = new Error(
            "Idempotency key already used for a different request"
          );
          error.status = 409;
          throw error;
        }

        if (existing.state === "DONE") {
          result = {
            status: existing.responseStatus,
            body: existing.responseBody,
          };
          return;
        }

        const error = new Error(
          "Request is already being processed"
        );
        error.status = 409;
        throw error;
      }

      await IdempotencyRecord.create(
        [
          {
            userId: fromUserId,
            key: idempotencyKey,
            requestHash,
            state: "IN_PROGRESS",
          },
        ],
        { session }
      );

      // Apply daily limit before moving money.
      await reserveDailySpend(fromUserId, amount, session);

      const senderWallet = await Wallet.findOneAndUpdate(
        {
          user: fromUserId,
          balance: { $gte: amount },
        },
        {
          $inc: { balance: -amount },
        },
        {
          new: true,
          session,
          runValidators: true,
        }
      );

      if (!senderWallet) {
        const error = new Error("Insufficient balance");
        error.status = 400;
        throw error;
      }

      const recipientWallet = await Wallet.findOneAndUpdate(
        { user: recipient._id },
        {
          $inc: { balance: amount },
        },
        {
          new: true,
          session,
          runValidators: true,
        }
      );

      if (!recipientWallet) {
        const error = new Error("Recipient wallet not found");
        error.status = 404;
        throw error;
      }

      const [transaction] = await Transaction.create(
        [
          {
            type: "TRANSFER",
            fromUserId,
            toUserId: recipient._id,
            amount,
            note: note || "",
            status: "SUCCESS",
          },
        ],
        { session }
      );

      await LedgerEntry.create(
        [
          {
            userId: fromUserId,
            transactionId: transaction._id,
            direction: "DEBIT",
            amount,
            balanceAfter: senderWallet.balance,
          },
          {
            userId: recipient._id,
            transactionId: transaction._id,
            direction: "CREDIT",
            amount,
            balanceAfter: recipientWallet.balance,
          },
        ],
        { session, ordered: true }
      );

      result = {
        status: 200,
        body: {
          message: "Transfer successful",
          transactionId: transaction._id.toString(),
          to: recipient.username,
          amount,
          balance: senderWallet.balance,
        },
      };

      await IdempotencyRecord.updateOne(
        {
          userId: fromUserId,
          key: idempotencyKey,
        },
        {
          $set: {
            state: "DONE",
            responseStatus: result.status,
            responseBody: result.body,
          },
        },
        { session }
      );
    });

    return result;
  } finally {
    await session.endSession();
  }
}

// ================= REQUEST WITHDRAWAL =================

async function requestWithdrawal({
  userId,
  bankAccountId,
  amount,
  idempotencyKey,
}) {
  if (
    !Number.isSafeInteger(amount) ||
    amount < 10000 ||
    amount > 2500000
  ) {
    const error = new Error(
      "Withdrawal amount must be between ₹100 and ₹25,000"
    );
    error.status = 400;
    throw error;
  }

  if (!idempotencyKey || typeof idempotencyKey !== "string") {
    const error = new Error("Idempotency-Key is required");
    error.status = 400;
    throw error;
  }

  const requestHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ bankAccountId, amount }))
    .digest("hex");

  const session = await mongoose.startSession();

  try {
    let result;

    await session.withTransaction(async () => {
      const existing = await IdempotencyRecord.findOne({
        userId,
        key: idempotencyKey,
      }).session(session);

      if (existing) {
        if (existing.requestHash !== requestHash) {
          const error = new Error(
            "Idempotency key already used for a different request"
          );
          error.status = 409;
          throw error;
        }

        if (existing.state === "DONE") {
          result = {
            status: existing.responseStatus,
            body: existing.responseBody,
          };
          return;
        }

        const error = new Error(
          "Request is already being processed"
        );
        error.status = 409;
        throw error;
      }

      await IdempotencyRecord.create(
        [
          {
            userId,
            key: idempotencyKey,
            requestHash,
            state: "IN_PROGRESS",
          },
        ],
        { session }
      );

      const bankAccount = await BankAccount.findOne({
        _id: bankAccountId,
        userId,
      }).session(session);

      if (!bankAccount) {
        const error = new Error("Bank account not found");
        error.status = 404;
        throw error;
      }

      // Apply the same daily limit used by transfers.
      await reserveDailySpend(userId, amount, session);

      const wallet = await Wallet.findOneAndUpdate(
        {
          user: userId,
          balance: { $gte: amount },
        },
        {
          $inc: { balance: -amount },
        },
        {
          new: true,
          session,
          runValidators: true,
        }
      );

      if (!wallet) {
        const error = new Error("Insufficient wallet balance");
        error.status = 400;
        throw error;
      }

      const withdrawalId = new mongoose.Types.ObjectId();
      const reference = `wd_${withdrawalId.toString()}`;

      const [withdrawal] = await Withdrawal.create(
        [
          {
            _id: withdrawalId,
            userId,
            bankAccountId,
            amount,
            reference,
            status: "PENDING",
          },
        ],
        { session }
      );

      const [transaction] = await Transaction.create(
        [
          {
            type: "WITHDRAWAL",
            fromUserId: userId,
            toUserId: null,
            amount,
            note: "Bank withdrawal",
            status: "SUCCESS",
          },
        ],
        { session }
      );

      await LedgerEntry.create(
        [
          {
            userId,
            transactionId: transaction._id,
            direction: "DEBIT",
            amount,
            balanceAfter: wallet.balance,
          },
        ],
        { session }
      );

      await OutboxEvent.create(
        [
          {
            type: "PAYOUT_REQUESTED",
            withdrawalId: withdrawal._id,
            status: "NEW",
            attempts: 0,
            nextAttemptAt: new Date(),
          },
        ],
        { session }
      );

      result = {
        status: 202,
        body: {
          message: "Withdrawal accepted for processing",
          withdrawalId: withdrawal._id.toString(),
          reference,
          amount,
          status: "PENDING",
          balance: wallet.balance,
        },
      };

      await IdempotencyRecord.updateOne(
        {
          userId,
          key: idempotencyKey,
        },
        {
          $set: {
            state: "DONE",
            responseStatus: result.status,
            responseBody: result.body,
          },
        },
        { session }
      );
    });

    return result;
  } finally {
    await session.endSession();
  }
}

// ================= REVERSE WITHDRAWAL =================

async function reverseWithdrawal({
  withdrawalId,
  failureReason,
}) {
  const session = await mongoose.startSession();

  try {
    let result;

    await session.withTransaction(async () => {
      const withdrawal = await Withdrawal.findOneAndUpdate(
        {
          _id: withdrawalId,
          status: { $in: ["PENDING", "PROCESSING"] },
        },
        {
          $set: {
            status: "REVERSED",
            failureReason:
              failureReason ||
              "Bank definitively refused payout",
          },
        },
        {
          new: true,
          session,
        }
      );

      if (!withdrawal) {
        const error = new Error(
          "Withdrawal not found or cannot be reversed"
        );
        error.status = 409;
        throw error;
      }

      const wallet = await Wallet.findOneAndUpdate(
        { user: withdrawal.userId },
        {
          $inc: { balance: withdrawal.amount },
        },
        {
          new: true,
          session,
          runValidators: true,
        }
      );

      if (!wallet) {
        throw new Error(
          "Wallet not found for withdrawal reversal"
        );
      }

      const [transaction] = await Transaction.create(
        [
          {
            type: "REVERSAL",
            fromUserId: null,
            toUserId: withdrawal.userId,
            amount: withdrawal.amount,
            note: "Bank withdrawal refund",
            status: "SUCCESS",
          },
        ],
        { session }
      );

      await LedgerEntry.create(
        [
          {
            userId: withdrawal.userId,
            transactionId: transaction._id,
            direction: "CREDIT",
            amount: withdrawal.amount,
            balanceAfter: wallet.balance,
          },
        ],
        { session }
      );

      await OutboxEvent.updateOne(
        { withdrawalId: withdrawal._id },
        {
          $set: {
            status: "DONE",
            lockedAt: null,
          },
        },
        { session }
      );

      result = {
        message: "Withdrawal reversed and wallet refunded",
        withdrawalId: withdrawal._id.toString(),
        status: "REVERSED",
        balance: wallet.balance,
      };
    });

    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = {
  transferMoney,
  requestWithdrawal,
  reverseWithdrawal,
};