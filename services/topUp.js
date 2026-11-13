
const mongoose = require("mongoose");
const PaymentOrder = require("../models/PaymentOrder");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const LedgerEntry = require("../models/LedgerEntry");

async function creditTopUp({
  razorpayOrderId,
  razorpayPaymentId,
  paidVia = "CALLBACK",
}) {
  const session = await mongoose.startSession();

  try {
    let result;

    await session.withTransaction(async () => {
      // Step 1: Claim the order so it cannot be credited twice.
      const paymentOrder = await PaymentOrder.findOneAndUpdate(
        {
          razorpayOrderId,
          status: { $in: ["CREATED", "EXPIRED"] },
        },
        {
          $set: {
            status: "PAID",
            razorpayPaymentId,
            paidVia,
          },
        },
        {
          new: true,
          session,
        }
      );

      // Step 2: Handle a payment that was already processed.
      if (!paymentOrder) {
        const existingOrder = await PaymentOrder.findOne({
          razorpayOrderId,
        }).session(session);

        if (existingOrder?.status === "PAID") {
          result = { alreadyPaid: true };
          return;
        }

        throw new Error("Payment order not found or cannot be paid");
      }

      // Step 3: Add money to the user's wallet.
      const wallet = await Wallet.findOneAndUpdate(
        { user: paymentOrder.userId },
        { $inc: { balance: paymentOrder.amount } },
        {
          new: true,
          session,
          runValidators: true,
        }
      );

      if (!wallet) {
        throw new Error("Wallet not found");
      }

      // Step 4: Create the transaction record.
      const [transaction] = await Transaction.create(
        [
          {
            type: "TOPUP",
            fromUserId: null,
            toUserId: paymentOrder.userId,
            amount: paymentOrder.amount,
            note: "Added via Razorpay",
            status: "SUCCESS",
          },
        ],
        { session }
      );

      // Step 5: Record the wallet credit in the ledger.
await LedgerEntry.create(
  [
    {
      userId: paymentOrder.userId,
      transactionId: transaction._id,
      type: "TOPUP",
      direction: "CREDIT",
      amount: paymentOrder.amount,
      balanceAfter: wallet.balance,
    },
  ],
  { session }
);

      // Step 6: Link the transaction to the payment order.
      paymentOrder.transactionId = transaction._id;
      await paymentOrder.save({ session });

      result = {
        alreadyPaid: false,
        amount: paymentOrder.amount,
        balance: wallet.balance,
        transactionId: transaction._id.toString(),
      };
    });

    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = { creditTopUp };
