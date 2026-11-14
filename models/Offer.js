
const mongoose = require("mongoose");

const offerSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 20,
      match: /^[A-Z0-9]+$/,
    },

    percent: {
      type: Number,
      required: true,
      min: 1,
      max: 50,
    },

    maxCashback: {
      type: Number,
      required: true,
      min: 1,
    },

    minPayment: {
      type: Number,
      required: true,
      min: 1,
    },

    budget: {
      type: Number,
      required: true,
      min: 1,
    },

    budgetLeft: {
      type: Number,
      required: true,
      min: 0,
    },

    startsAt: {
      type: Date,
      required: true,
    },

    endsAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.Offer || mongoose.model("Offer", offerSchema);
