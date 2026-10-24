const JWT_SECRET = "kaasupay-dev-secret";

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

if (
  !RAZORPAY_KEY_ID ||
  !RAZORPAY_KEY_SECRET ||
  !RAZORPAY_WEBHOOK_SECRET
) {
  throw new Error("Missing Razorpay environment variables");
}

module.exports = { JWT_SECRET ,
RAZORPAY_KEY_ID,
RAZORPAY_KEY_SECRET,
RAZORPAY_WEBHOOK_SECRET,
};