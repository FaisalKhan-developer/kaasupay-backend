
const mongoose = require("mongoose");

const mandateRunSchema = new mongoose.Schema(
  {
    mandateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Mandate",
      required: true,
    },
    dueDay: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["SUCCESS", "FAILED", "MISSED"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
    },
    reason: {
      type: String,
      default: "",
    },
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },
  },
  { timestamps: true }
);

mandateRunSchema.index(
  { mandateId: 1, dueDay: 1 },
  { unique: true }
);

module.exports =
  mongoose.models.MandateRun ||
  mongoose.model("MandateRun", mandateRunSchema);
