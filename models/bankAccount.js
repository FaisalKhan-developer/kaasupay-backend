
const mongoose = require("mongoose");

const bankAccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    holderName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    accountNumber: {
      type: String,
      required: true,
      select: false,
    },
    ifsc: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: /^[A-Z]{4}0[A-Z0-9]{6}$/,
    },
    last4: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

bankAccountSchema.index(
  { userId: 1, accountNumber: 1 },
  { unique: true }
);

module.exports = mongoose.model("BankAccount", bankAccountSchema);
