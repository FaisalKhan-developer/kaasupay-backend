const express = require("express");
const { z } = require("zod");
const jwt = require("jsonwebtoken");

const { JWT_SECRET } = require("../config");
const User = require("../models/User");
const Wallet = require("../models/Wallet");
const DailySpend = require("../models/DailySpend");
const { createRateLimiter } = require("../middleware/rateLimiter");

const { transferMoney } = require("../services/money");
const { checkPin } = require("../services/pin");

const router = express.Router();

const DAILY_LIMIT = 1000000; // ₹10,000 in paise

const moneyLimiter = createRateLimiter({
  keyGenerator: (req) => `money:${req.user.userId}`,
  limit: 10,
  windowMs: 60 * 1000,
  message: "Too many money transactions. Try again later.",
});

// ================= AUTHENTICATION =================

router.use(async (req, res, next) => {
  const authHeader = req.get("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Authentication required",
    });
  }

  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);

    const user = await User.findById(decoded.userId)
      .select("tokenVersion");

    if (!user || (decoded.tv ?? 0) !== (user.tokenVersion ?? 0)) {
      return res.status(401).json({
        error: "Session expired. Please log in again.",
      });
    }

    req.user = {
      userId: user._id,
    };

    next();
  } catch (error) {
    if (error.name === "JsonWebTokenError" ||
        error.name === "TokenExpiredError") {
      return res.status(401).json({
        error: "Invalid or expired token",
      });
    }

    console.error("Authentication error:", error);

    return res.status(500).json({
      error: "Authentication failed",
    });
  }
});

// ================= TRANSFER VALIDATION =================

const transferSchema = z.object({
  to: z.string().trim().email(),
  amount: z.number().int().min(100).max(10000000),
  note: z.string().trim().max(50).optional().default(""),
  pin: z.string().regex(/^\d{4}(?:\d{2})?$/, {
    message: "PIN must contain 4 or 6 digits",
  }),
});

// ================= TRANSFER =================

router.post("/transfer", moneyLimiter, async (req, res) => {
  try {
    const parsed = transferSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues
          .map((issue) =>
            `${issue.path.join(".")}: ${issue.message}`
          )
          .join(", "),
      });
    }

    const idempotencyKey = req.get("idempotency-key");

    if (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.trim().length < 8 ||
      idempotencyKey.length > 128
    ) {
      return res.status(400).json({
        error: "Provide an Idempotency-Key header (8-128 characters)",
      });
    }

    // Verify PIN before creating the money transaction.
    const pinResult = await checkPin(
      req.user.userId,
      parsed.data.pin
    );

    if (!pinResult.ok) {
      if (pinResult.retryAfter) {
        res.set("Retry-After", String(pinResult.retryAfter));
      }

      return res.status(pinResult.status || 403).json({
        error: pinResult.error,
        attemptsRemaining: pinResult.attemptsRemaining,
      });
    }

    const result = await transferMoney({
      fromUserId: req.user.userId,
      to: parsed.data.to,
      amount: parsed.data.amount,
      note: parsed.data.note,
      idempotencyKey: idempotencyKey.trim(),
    });

    return res.status(result.status).json(result.body);

  } catch (error) {
    console.error("Transfer error:", error);

    return res.status(error.status || 500).json({
      error: error.status ? error.message : "Transfer failed",
    });
  }
});

// ================= WALLET BALANCE =================

router.get("/balance", async (req, res) => {
  try {
    const wallet = await Wallet.findOne({
      user: req.user.userId,
    });

    if (!wallet) {
      return res.status(404).json({
        error: "Wallet not found",
      });
    }

    return res.status(200).json({
      balance: wallet.balance,
    });

  } catch (error) {
    console.error("Wallet balance error:", error);

    return res.status(500).json({
      error: "Failed to fetch wallet balance",
    });
  }
});

// ================= DAILY SPENDING LIMIT =================

router.get("/limits", async (req, res) => {
  try {
    // Calculate today's date in India (UTC + 5:30).
    const indiaNow = new Date(
      Date.now() + 330 * 60 * 1000
    );

    const today = indiaNow.toISOString().slice(0, 10);

    const dailySpend = await DailySpend.findOne({
      userId: req.user.userId,
      day: today,
    }).lean();

    const usedToday = dailySpend?.spent || 0;
    const leftToday = Math.max(0, DAILY_LIMIT - usedToday);

    // Next midnight in India, represented as UTC timestamp.
    const resetsAt = new Date(
      new Date(`${today}T00:00:00+05:30`).getTime() +
      24 * 60 * 60 * 1000
    );

    return res.status(200).json({
      dailyLimit: DAILY_LIMIT,
      usedToday,
      leftToday,
      resetsAt,
      currency: "INR",
      unit: "paise",
    });

  } catch (error) {
    console.error("Daily limit error:", error);

    return res.status(500).json({
      error: "Unable to fetch daily spending limit",
    });
  }
});

module.exports = router;