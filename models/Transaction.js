
const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["DEPOSIT", "TRANSFER", "TOPUP", "WITHDRAWAL", "REVERSAL"],
      required: true,
    },
    fromUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
toUserId: {
  type: mongoose.Schema.Types.ObjectId,
  ref: "User",
  default: null,
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
    note: {
      type: String,
      trim: true,
      maxlength: 50,
      default: "",
    },
    status: {
      type: String,
      enum: ["SUCCESS"],
      default: "SUCCESS",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Transaction", transactionSchema);
