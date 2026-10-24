
const express = require("express");
const { z } = require("zod");
const jwt = require("jsonwebtoken");

const { JWT_SECRET } = require("../config");
const User = require("../models/User");
const Wallet = require("../models/Wallet");
const { transferMoney } = require("../services/money");

const router = express.Router();
router.use((req, res, next) => {
  const authHeader = req.get("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Authentication required",
    });
  }

  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    req.user = { userId: decoded.userId };
    next();
  } catch {
    return res.status(401).json({
      error: "Invalid or expired token",
    });
  }
});


const transferSchema = z.object({
  to: z.string().trim().email(),
  amount: z.number().int().min(100).max(10000000),
  note: z.string().trim().max(50).optional().default(""),
});

router.post("/transfer", async (req, res) => {
  try {
    // Read the JWT from the Authorization header
    const authHeader = req.get("authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required" });
    }

    let decoded;

    try {
      decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    } catch {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const parsed = transferSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
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

    const result = await transferMoney({
      fromUserId: decoded.userId,
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
router.get("/balance", async (req, res) => {
  try {
    const wallet = await Wallet.findOne({
      user: req.user.userId
    });

    if (!wallet) {
      return res.status(404).json({
        error: "Wallet not found"
      });
    }

    return res.status(200).json({
      balance: wallet.balance
    });
  } catch (error) {
    console.error("Wallet balance error:", error);

    return res.status(500).json({
      error: "Failed to fetch wallet balance"
    });
  }
});
module.exports = router;
