
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rootRouter = require("./routes/index");
const connectDB = require("./mongodb");
const crypto = require("crypto");
const { RAZORPAY_WEBHOOK_SECRET } = require("./config");
const { creditTopUp } = require("./services/topUp");
const PaymentOrder = require("./models/PaymentOrder");

const app = express();
// Connect to MongoDB before handling requests
let dbConnectionPromise;

app.use(async (req, res, next) => {
  try {
    if (!dbConnectionPromise) {
      dbConnectionPromise = connectDB().catch((error) => {
        dbConnectionPromise = null;
        throw error;
      });
    }

    await dbConnectionPromise;
    next();
  } catch (error) {
    console.error("Database connection failed:", error.message);
    res.status(503).json({ error: "Database unavailable" });
  }
});

// Razorpay webhook must receive the raw body before JSON parsing
app.post(
  "/api/v1/webhooks/razorpay",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.get("x-razorpay-signature");

      if (!signature || !Buffer.isBuffer(req.body)) {
        return res.status(400).json({ error: "Invalid webhook request" });
      }

      const expected = crypto
        .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
        .update(req.body)
        .digest();

      let received;

      try {
        received = Buffer.from(signature, "hex");
      } catch {
        return res.status(400).json({ error: "Invalid webhook signature" });
      }

      if (
        received.length !== expected.length ||
        !crypto.timingSafeEqual(received, expected)
      ) {
        return res.status(400).json({ error: "Webhook signature verification failed" });
      }

      const event = JSON.parse(req.body.toString("utf8"));

      if (event.event === "payment.captured") {
        const payment = event.payload?.payment?.entity;

        if (!payment?.order_id || !payment?.id) {
          return res.status(400).json({ error: "Missing payment details" });
        }

        const paymentOrder = await PaymentOrder.findOne({
          razorpayOrderId: payment.order_id,
        });

        if (!paymentOrder) {
          return res.status(404).json({ error: "Payment order not found" });
        }

        if (
          payment.amount !== paymentOrder.amount ||
          payment.currency !== paymentOrder.currency
        ) {
          return res.status(400).json({ error: "Payment amount or currency mismatch" });
        }

await creditTopUp({
  razorpayOrderId: payment.order_id,
  razorpayPaymentId: payment.id,
  paidVia: "WEBHOOK",
});
      }

      return res.status(200).json({ received: true });
    } catch (error) {
      console.error("Razorpay webhook error:", error.message);
      return res.status(500).json({ error: "Webhook processing failed" });
    }
  }
);

const allowedOrigins = [
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS"));
  }
}));

app.use(express.json());
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.json({ status: "KaasuPay backend is running" });
});

app.use("/api/v1", rootRouter);

if (require.main === module) {
  async function startServer() {
    await connectDB();

    const PORT = process.env.PORT || 3000;

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }

  startServer().catch((error) => {
    console.error("Server startup failed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = app;