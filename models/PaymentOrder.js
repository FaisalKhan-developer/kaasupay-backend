
const mongoose = require("mongoose");

const paymentOrderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    razorpayOrderId: {
      type: String,
      required: true,
      unique: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 1000,
      max: 1000000,
    },

    currency: {
      type: String,
      default: "INR",
      required: true,
    },

    status: {
      type: String,
      enum: ["CREATED", "PAID", "EXPIRED"],
      default: "CREATED",
      required: true,
    },

    razorpayPaymentId: {
      type: String,
      default: null,
    },

    paidVia: {
      type: String,
      enum: ["CALLBACK", "WEBHOOK"],
      default: null,
    },

    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PaymentOrder", paymentOrderSchema);
