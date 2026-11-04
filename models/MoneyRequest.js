
const mongoose = require("mongoose");

const moneyRequestSchema = new mongoose.Schema(
  {
    requesterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    payerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 100,
      max: 1000000,
    },

    note: {
      type: String,
      trim: true,
      maxlength: 100,
      default: "",
    },

    status: {
      type: String,
      enum: ["PENDING", "PAID", "DECLINED", "CANCELLED", "EXPIRED"],
      default: "PENDING",
      required: true,
    },

    expiresAt: {
      type: Date,
      required: true,
    },

    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    decidedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

moneyRequestSchema.index({ payerId: 1, status: 1, createdAt: -1 });
moneyRequestSchema.index({ requesterId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("MoneyRequest", moneyRequestSchema);
