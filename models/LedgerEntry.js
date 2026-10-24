
const mongoose = require("mongoose");

const ledgerEntrySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      required: true,
    },
    direction: {
      type: String,
      enum: ["DEBIT", "CREDIT"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "Amount must be a whole number in paise",
      },
    },
    balanceAfter: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "Balance must be a whole number in paise",
      },
    },
  },
  {
    timestamps: true,
  }
);

// Helps fetch a user's latest transactions efficiently
ledgerEntrySchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("LedgerEntry", ledgerEntrySchema);
