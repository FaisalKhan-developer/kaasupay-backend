
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
    type: {
      type: String,
      enum: [
        "TRANSFER",
        "DEPOSIT",
        "TOPUP",
        "WITHDRAWAL",
        "REVERSAL",
      ],
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

// Day 8: Cursor pagination index
ledgerEntrySchema.index({
  userId: 1,
  createdAt: -1,
  _id: -1,
});

// Day 8: Type-filtered history index
ledgerEntrySchema.index({
  userId: 1,
  type: 1,
  createdAt: -1,
  _id: -1,
});

module.exports = mongoose.model("LedgerEntry", ledgerEntrySchema);
