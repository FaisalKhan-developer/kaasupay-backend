const express = require("express");
const { z } = require("zod");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const User = require("../models/User");
const Wallet = require("../models/Wallet");
const { JWT_SECRET } = require("../config");
const { transferMoney } = require("../services/money");

const router = express.Router();

// ================= AUTHENTICATION MIDDLEWARE =================

function authenticate(req, res, next) {
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
}

// ================= VALIDATION HELPER =================

function firstError(zodError) {
  const issue = zodError.issues[0];
  const field = issue.path[0] || "body";

  return `${field}: ${issue.message}`;
}

// ================= SIGNUP =================

const signupSchema = z.object({
  username: z.string().trim().toLowerCase().email(),
  firstName: z.string().trim().min(1).max(50),
  lastName: z.string().trim().min(1).max(50),
  password: z.string().min(6),
});

router.post("/signup", async (req, res) => {
  try {
    const result = signupSchema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: firstError(result.error),
      });
    }

    const { username, firstName, lastName, password } = result.data;

    const existing = await User.findOne({ username });

    if (existing) {
      return res.status(409).json({
        error: "This email is already registered",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await User.create({
      username,
      firstName,
      lastName,
      passwordHash,
    });

    let wallet;

    try {
      wallet = await Wallet.create({
        user: user._id,
        balance: 0,
      });
    } catch (walletError) {
      await User.deleteOne({ _id: user._id });
      throw walletError;
    }

    return res.status(201).json({
      message: "User created successfully",
      user: {
        id: user._id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
      },
      wallet: {
        id: wallet._id,
        balance: wallet.balance,
      },
    });
  } catch (error) {
    console.error("Signup error:", error);

    if (error.code === 11000) {
      return res.status(409).json({
        error: "This email is already registered",
      });
    }

    return res.status(500).json({
      error: "Unable to create user",
    });
  }
});

// ================= SIGNIN =================

const signinSchema = z.object({
  username: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

router.post("/signin", async (req, res) => {
  try {
    const result = signinSchema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: firstError(result.error),
      });
    }

    const { username, password } = result.data;

    const user = await User.findOne({ username });

    if (!user) {
      return res.status(401).json({
        error: "Wrong email or password",
      });
    }

    const passwordOk = await bcrypt.compare(
      password,
      user.passwordHash
    );

    if (!passwordOk) {
      return res.status(401).json({
        error: "Wrong email or password",
      });
    }

    if (!JWT_SECRET) {
      throw new Error("JWT_SECRET is not configured");
    }

    const token = jwt.sign(
      { userId: user._id.toString() },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    return res.json({
      message: "Signed in",
      token,
    });
  } catch (error) {
    console.error("Signin error:", error.message);

    return res.status(500).json({
      error: "Unable to sign in",
    });
  }
});

// ================= TRANSFER MONEY =================

const transferSchema = z.object({
  to: z.string().trim().email(),
  amount: z.number().int().min(100).max(10000000),
  note: z.string().trim().max(50).optional().default(""),
});

router.post("/transfer", authenticate, async (req, res) => {
  try {
    const result = transferSchema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: firstError(result.error),
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

    const transferResult = await transferMoney({
      fromUserId: req.user.userId,
      to: result.data.to,
      amount: result.data.amount,
      note: result.data.note,
      idempotencyKey: idempotencyKey.trim(),
    });

    return res
      .status(transferResult.status)
      .json(transferResult.body);
  } catch (error) {
    console.error("Transfer error:", error);

    return res.status(error.status || 500).json({
      error: error.status ? error.message : "Transfer failed",
    });
  }
});

module.exports = router;