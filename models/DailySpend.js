const mongoose = require("mongoose");

const dailySpendSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    day: {
      type: String,
      required: true,
    },
    spent: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

dailySpendSchema.index(
  { userId: 1, day: 1 },
  { unique: true }
);

module.exports = mongoose.model("DailySpend", dailySpendSchema);