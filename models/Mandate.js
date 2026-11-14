
const mongoose = require("mongoose");

const mandateSchema = new mongoose.Schema(
  {
    payerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    payeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 100,
      max: 500000,
    },
    dayOfMonth: {
      type: Number,
      required: true,
      min: 1,
      max: 28,
    },
    status: {
      type: String,
      enum: ["ACTIVE", "PAUSED", "CANCELLED"],
      default: "ACTIVE",
      required: true,
    },
    nextRunDay: {
      type: String,
      required: true,
    },
    failedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

mandateSchema.index({ status: 1, nextRunDay: 1 });

module.exports =
  mongoose.models.Mandate ||
  mongoose.model("Mandate", mandateSchema);
