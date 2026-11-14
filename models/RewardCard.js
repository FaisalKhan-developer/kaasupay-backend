
const mongoose = require("mongoose");

const rewardCardSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    offerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Offer",
      required: true,
    },

    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      required: true,
      unique: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    status: {
      type: String,
      enum: ["UNCLAIMED", "CLAIMED", "EXHAUSTED", "EXPIRED"],
      default: "UNCLAIMED",
      required: true,
    },

    expiresAt: {
      type: Date,
      required: true,
    },

    cashbackTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    claimedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

rewardCardSchema.index({ userId: 1, createdAt: -1 });

module.exports =
  mongoose.models.RewardCard ||
  mongoose.model("RewardCard", rewardCardSchema);
