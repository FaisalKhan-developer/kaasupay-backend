require("dotenv").config();
const JWT_SECRET = process.env.JWT_SECRET;

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

if (!JWT_SECRET) {
  throw new Error("Missing JWT_SECRET environment variable");
}

if (
  !RAZORPAY_KEY_ID ||
  !RAZORPAY_KEY_SECRET ||
  !RAZORPAY_WEBHOOK_SECRET
) {
  throw new Error("Missing Razorpay environment variables");
}

module.exports = {
  JWT_SECRET,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
};