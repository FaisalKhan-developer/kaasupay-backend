const crypto = require("crypto");
const { creditTopUp } = require("../services/topUp");
const PaymentOrder = require("../models/PaymentOrder");
const express = require("express");
const Razorpay = require("razorpay");
const jwt = require("jsonwebtoken");

const {
  JWT_SECRET,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
} = require("../config");

const router = express.Router();

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

router.post("/order", async (req, res) => {
  try {
    // 1. Verify JWT authentication
    const authHeader = req.get("authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Authentication required",
      });
    }

    let decoded;

    try {
      decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    } catch {
      return res.status(401).json({
        error: "Invalid or expired token",
      });
    }

    // 2. Validate amount (in paise)
    const { amount } = req.body || {};

    if (
      !Number.isInteger(amount) ||
      amount < 1000 ||
      amount > 1000000
    ) {
      return res.status(400).json({
        error: "Amount must be an integer between 1000 and 1000000 paise",
      });
    }

    // 3. Create Razorpay order
    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
      notes: {
        userId: decoded.userId,
      },
    });

    await PaymentOrder.create({
  userId: decoded.userId,
  razorpayOrderId: order.id,
  amount: order.amount,
  currency: order.currency,
  status: "CREATED",
});

    return res.status(201).json({
      message: "Razorpay order created successfully",
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("Razorpay order error:", error.message);

    return res.status(500).json({
      error: "Failed to create Razorpay order",
    });
  }
});


router.post("/verify", async (req, res) => {
  try {
    // Verify the user's JWT
    const authHeader = req.get("authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Authentication required",
      });
    }

    let decoded;

    try {
      decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    } catch {
      return res.status(401).json({
        error: "Invalid or expired token",
      });
    }

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body || {};

    if (
      typeof razorpay_order_id !== "string" ||
      typeof razorpay_payment_id !== "string" ||
      typeof razorpay_signature !== "string"
    ) {
      return res.status(400).json({
        error: "Missing payment verification details",
      });
    }

    // Ensure this order belongs to the logged-in user
    const paymentOrder = await PaymentOrder.findOne({
      razorpayOrderId: razorpay_order_id,
      userId: decoded.userId,
    });

    if (!paymentOrder) {
      return res.status(404).json({
        error: "Payment order not found",
      });
    }

    // Verify Razorpay HMAC SHA-256 signature
    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest();

    let receivedSignature;

    try {
      receivedSignature = Buffer.from(razorpay_signature, "hex");
    } catch {
      return res.status(400).json({
        error: "Invalid payment signature",
      });
    }

    if (
      receivedSignature.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(receivedSignature, expectedSignature)
    ) {
      return res.status(400).json({
        error: "Payment signature verification failed",
      });
    }

const result = await creditTopUp({
  razorpayOrderId: razorpay_order_id,
  razorpayPaymentId: razorpay_payment_id,
  paidVia: "CALLBACK",
});

    return res.status(200).json({
      message: result.alreadyPaid
        ? "Payment was already processed"
        : "Payment verified and wallet credited",
      ...result,
    });
  } catch (error) {
    console.error("Payment verification error:", error.message);

    return res.status(500).json({
      error: "Payment verification failed",
    });
  }
});


router.get("/orders/:orderId", async (req, res) => {
  try {
    const authHeader = req.get("authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Authentication required"
      });
    }

    let decoded;

    try {
      decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    } catch {
      return res.status(401).json({
        error: "Invalid or expired token"
      });
    }

    const order = await PaymentOrder.findOne({
      razorpayOrderId: req.params.orderId,
      userId: decoded.userId
    });

    if (!order) {
      return res.status(404).json({
        error: "Order not found"
      });
    }

    return res.status(200).json({
      orderId: order.razorpayOrderId,
      amount: order.amount,
      status: order.status,
      paidVia: order.paidVia || null
    });
  } catch (error) {
    console.error("Order status error:", error.message);

    return res.status(500).json({
      error: "Failed to fetch order status"
    });
  }
});


module.exports = router;
