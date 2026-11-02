
const express = require("express");
const { z } = require("zod");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const User = require("../models/User");
const Wallet = require("../models/Wallet");
const { JWT_SECRET } = require("../config");
const { transferMoney } = require("../services/money");
const { checkPin } = require("../services/pin");
const { createRateLimiter } = require("../middleware/rateLimiter");

const router = express.Router();

// ================= RATE LIMITERS =================

const signupLimiter = createRateLimiter({
  keyGenerator: (req) => `signup:${req.ip}`,
  limit: 10,
  windowMs: 60 * 60 * 1000,
});

const signinEmailLimiter = createRateLimiter({
  keyGenerator: (req) =>
    `signin-email:${String(req.body?.username || "")
      .trim()
      .toLowerCase() || req.ip}`,
  limit: 5,
  windowMs: 60 * 1000,
});

const signinIpLimiter = createRateLimiter({
  keyGenerator: (req) => `signin-ip:${req.ip}`,
  limit: 20,
  windowMs: 60 * 1000,
});

const pinSetupLimiter = createRateLimiter({
  keyGenerator: (req) => `pin-setup:${req.user.userId}`,
  limit: 5,
  windowMs: 60 * 60 * 1000,
});

const moneyLimiter = createRateLimiter({
  keyGenerator: (req) => `money:${req.user.userId}`,
  limit: 10,
  windowMs: 60 * 1000,
});

// ================= AUTHENTICATION =================

async function authenticate(req, res, next) {
  const authHeader = req.get("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Authentication required",
    });
  }

  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);

    const user = await User.findById(decoded.userId).select(
      "tokenVersion"
    );

    if (!user) {
      return res.status(401).json({
        error: "User not found",
      });
    }

    if ((decoded.tv ?? 0) !== (user.tokenVersion ?? 0)) {
      return res.status(401).json({
        error: "Session expired. Please sign in again.",
      });
    }

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

router.post("/signup", signupLimiter, async (req, res) => {
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

router.post(
  "/signin",
  signinEmailLimiter,
  signinIpLimiter,
  async (req, res) => {
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
        {
          userId: user._id.toString(),
          tv: user.tokenVersion ?? 0,
        },
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
  }
);

// ================= SET PAYMENT PIN =================

const pinSchema = z.object({
  password: z.string().min(1),
  pin: z.string().regex(/^\d{4}(?:\d{2})?$/, "PIN must be 4 or 6 digits"),
});

router.post(
  "/pin",
  authenticate,
  pinSetupLimiter,
  async (req, res) => {
    try {
      const result = pinSchema.safeParse(req.body);

      if (!result.success) {
        return res.status(400).json({
          error: firstError(result.error),
        });
      }

      const { password, pin } = result.data;

      if (/^(\d)\1+$/.test(pin)) {
        return res.status(400).json({
          error: "Choose a stronger PIN",
        });
      }

      const user = await User.findById(req.user.userId);

      if (!user) {
        return res.status(404).json({
          error: "User not found",
        });
      }

      if (user.pinHash) {
        return res.status(409).json({
          error: "Payment PIN is already set",
        });
      }

      const passwordOk = await bcrypt.compare(
        password,
        user.passwordHash
      );

      if (!passwordOk) {
        return res.status(401).json({
          error: "Incorrect account password",
        });
      }

      user.pinHash = await bcrypt.hash(pin, 10);
      user.pinFailedCount = 0;
      user.pinLockedUntil = null;

      await user.save();

      return res.status(201).json({
        message: "Payment PIN created successfully",
      });
    } catch (error) {
      console.error("PIN setup error:", error);

      return res.status(500).json({
        error: "Unable to set payment PIN",
      });
    }
  }
);

// ================= CURRENT USER =================

router.get("/me", authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select(
      "username firstName lastName pinHash"
    );

    if (!user) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    return res.json({
      user: {
        id: user._id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        hasPin: Boolean(user.pinHash),
      },
    });
  } catch (error) {
    console.error("Profile error:", error);

    return res.status(500).json({
      error: "Unable to fetch profile",
    });
  }
});

// ================= TRANSFER MONEY =================

const transferSchema = z.object({
  to: z.string().trim().email(),
  amount: z.number().int().min(100).max(10000000),
  note: z.string().trim().max(50).optional().default(""),
  pin: z.string().regex(/^\d{4}(?:\d{2})?$/, "PIN must be 4 or 6 digits"),
});

router.post(
  "/transfer",
  authenticate,
  moneyLimiter,
  async (req, res) => {
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

      const pinResult = await checkPin(
        req.user.userId,
        result.data.pin
      );

      if (!pinResult.ok) {
        if (pinResult.retryAfter) {
          res.set("Retry-After", String(pinResult.retryAfter));
        }

        return res.status(pinResult.status).json({
          error: pinResult.error,
          ...(pinResult.attemptsRemaining !== undefined && {
            attemptsRemaining: pinResult.attemptsRemaining,
          }),
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
  }
);

// ================= LOGOUT ALL DEVICES =================

router.post("/logout-all", authenticate, async (req, res) => {
  try {
    await User.findByIdAndUpdate(
      req.user.userId,
      { $inc: { tokenVersion: 1 } }
    );

    return res.json({
      message: "All sessions have been logged out",
    });
  } catch (error) {
    console.error("Logout-all error:", error);

    return res.status(500).json({
      error: "Unable to log out all sessions",
    });
  }
});

module.exports = router;
