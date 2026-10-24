require("dotenv").config();

const mongoose = require("mongoose");
const axios = require("axios");

const OutboxEvent = require("./models/OutboxEvent");
const Withdrawal = require("./models/Withdrawal");
const BankAccount = require("./models/bankAccount");
const { reverseWithdrawal } = require("./services/money");

const BANK_URL = process.env.BANK_URL || "http://localhost:4000";
const MAX_ATTEMPTS = 5;
const BANK_TIMEOUT = 3000;

// Wait for a specified time
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Calculate retry delay using exponential backoff and jitter
function getRetryDelay(attempts) {
  const baseDelay = Math.min(60000, 5000 * 2 ** (attempts - 1));
  const jitter = Math.floor(Math.random() * 1000);

  return baseDelay + jitter;
}

// Process one payout job
async function processOne() {
  // Claim one available payout job
  const event = await OutboxEvent.findOneAndUpdate(
{
  $or: [
    {
      status: "NEW",
      nextAttemptAt: { $lte: new Date() },
    },
    {
      status: "PROCESSING",
      lockedAt: {
        $lte: new Date(Date.now() - 60 * 1000),
      },
    },
  ],
},
    {
      $set: {
        status: "PROCESSING",
        lockedAt: new Date(),
      },
      $inc: {
        attempts: 1,
      },
    },
    {
      returnDocument: "after",
      sort: { nextAttemptAt: 1 },
    }
  );

  // No payout job is available
  if (!event) {
    return false;
  }

  try {
    const withdrawal = await Withdrawal.findById(event.withdrawalId);

    if (!withdrawal) {
      throw new Error("Withdrawal not found");
    }

    // Do not process an already completed withdrawal
    if (
      withdrawal.status === "SUCCESS" ||
      withdrawal.status === "REVERSED"
    ) {
      await OutboxEvent.updateOne(
        { _id: event._id },
        {
          $set: {
            status: "DONE",
            lockedAt: null,
          },
        }
      );

      return true;
    }

    // Find the bank account and explicitly include its hidden account number
    const bankAccount = await BankAccount.findById(
      withdrawal.bankAccountId
    ).select("+accountNumber");

    if (!bankAccount) {
      throw new Error("Bank account not found");
    }

    // Move a pending withdrawal to processing
    if (withdrawal.status === "PENDING") {
      const updateResult = await Withdrawal.updateOne(
        {
          _id: withdrawal._id,
          status: "PENDING",
        },
        {
          $set: {
            status: "PROCESSING",
          },
        }
      );

      if (updateResult.matchedCount === 0) {
        throw new Error("Withdrawal status changed; payout not submitted");
      }
    } else if (withdrawal.status !== "PROCESSING") {
      throw new Error(
        `Withdrawal cannot be processed from status ${withdrawal.status}`
      );
    }

    // Submit payout using the same reference on every retry
    const response = await axios.post(
      `${BANK_URL}/payouts`,
      {
        reference: withdrawal.reference,
        amount: withdrawal.amount,
        accountNumber: bankAccount.accountNumber,
        ifsc: bankAccount.ifsc,
      },
      {
        timeout: BANK_TIMEOUT,
      }
    );

    // The bank confirmed success
    if (
      response.data?.status === "SUCCESS" &&
      typeof response.data.bankRef === "string" &&
      response.data.bankRef.length > 0
    ) {
      const updateResult = await Withdrawal.updateOne(
        {
          _id: withdrawal._id,
          status: "PROCESSING",
        },
        {
          $set: {
            status: "SUCCESS",
            bankRef: response.data.bankRef,
            failureReason: null,
          },
        }
      );

      if (updateResult.matchedCount === 0) {
        throw new Error(
          "Bank reported success, but withdrawal status could not be updated"
        );
      }

      await OutboxEvent.updateOne(
        { _id: event._id },
        {
          $set: {
            status: "DONE",
            lockedAt: null,
            lastError: null,
          },
        }
      );

      console.log(`Withdrawal ${withdrawal.reference} succeeded`);
      return true;
    }

    // An uncertain response must be retried, not automatically refunded
    throw new Error("Bank payout is still processing or returned an unknown result");
  } catch (error) {
    const message =
      error.response?.data?.message || error.message || "Unknown payout error";

    const statusCode = error.response?.status;

    // A definite 4xx rejection from the demo bank is treated as permanent.
    // Timeouts, 429 responses and server errors are retried because
    // the bank may already have processed the payout.
    if (
      statusCode >= 400 &&
      statusCode < 500 &&
      statusCode !== 429
    ) {
      try {
        await reverseWithdrawal({
          withdrawalId: event.withdrawalId,
          failureReason: message,
        });

        console.log(
          `Withdrawal rejected and reversed: ${event.withdrawalId}`
        );

        return true;
      } catch (refundError) {
        console.error(
          "Withdrawal reversal failed:",
          refundError.message
        );
      }
    }

    // After five attempts, stop automatic retries and request manual review
    if (event.attempts >= MAX_ATTEMPTS) {
      await Withdrawal.updateOne(
        {
          _id: event.withdrawalId,
          status: { $in: ["PENDING", "PROCESSING"] },
        },
        {
          $set: {
            status: "NEEDS_REVIEW",
            failureReason: message,
          },
        }
      );

      await OutboxEvent.updateOne(
        { _id: event._id },
        {
          $set: {
            status: "STUCK",
            lockedAt: null,
            lastError: message,
          },
        }
      );

      console.error(
        `Withdrawal needs manual review: ${event.withdrawalId}`
      );
    } else {
      // Schedule another attempt
      await OutboxEvent.updateOne(
        { _id: event._id },
        {
          $set: {
            status: "NEW",
            lockedAt: null,
            nextAttemptAt: new Date(
              Date.now() + getRetryDelay(event.attempts)
            ),
            lastError: message,
          },
        }
      );

      console.error(
        `Payout attempt ${event.attempts}/${MAX_ATTEMPTS} failed: ${message}`
      );
    }

    return true;
  }
}

// Connect to MongoDB and keep the worker running
async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing from .env");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  console.log("Payout worker connected to MongoDB");

  while (true) {
    try {
      const processed = await processOne();

      if (!processed) {
        await sleep(1000);
      }
    } catch (error) {
      // A temporary database or job-processing error should not
      // immediately terminate the worker loop.
      console.error("Worker iteration failed:", error.message);
      await sleep(2000);
    }
  }
}

main().catch(async (error) => {
  console.error("Worker could not start:", error.message);

  await mongoose.disconnect().catch(() => {});

  process.exitCode = 1;
});