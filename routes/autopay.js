
const express = require("express");
const { z } = require("zod");
const jwt = require("jsonwebtoken");

const { JWT_SECRET } = require("../config");
const User = require("../models/User");
const Mandate = require("../models/Mandate");
const { checkPin } = require("../services/pin");

const router = express.Router();

// Authentication middleware — reused from routes/wallet.js
async function authMiddleware(req, res, next) {
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
    if (
      error.name === "JsonWebTokenError" ||
      error.name === "TokenExpiredError"
    ) {
      return res.status(401).json({
        error: "Invalid or expired token",
      });
    }

    console.error("Authentication error:", error);

    return res.status(500).json({
      error: "Authentication failed",
    });
  }
}

// Setup validation
const setupSchema = z.object({
  to: z.string().regex(/^[a-f\d]{24}$/i),
  amount: z.number().int().min(100).max(500000),
  dayOfMonth: z.number().int().min(1).max(28),
  pin: z.string().regex(/^\d{4}(\d{2})?$/),
});

// Get current India date
function getIndiaDay() {
  return new Date(Date.now() + 330 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

// Calculate the next payment date
function getNextRunDay(dayOfMonth) {
  const today = getIndiaDay();

  const [year, month, day] = today.split("-").map(Number);

  let nextYear = year;
  let nextMonth = month;

  // Never charge on the setup day
  if (day >= dayOfMonth) {
    nextMonth++;

    if (nextMonth > 12) {
      nextMonth = 1;
      nextYear++;
    }
  }

  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-${String(
    dayOfMonth
  ).padStart(2, "0")}`;
}

// POST /autopay — Set up a new AutoPay
router.post("/", authMiddleware, async (req, res) => {
  try {
    const parsed = setupSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid inputs",
      });
    }

    const { to, amount, dayOfMonth, pin } = parsed.data;
    const payerId = req.user.userId;

    // Prevent paying yourself
    if (to === payerId.toString()) {
      return res.status(400).json({
        message: "You can't set up AutoPay to yourself",
      });
    }

    // Check whether payee exists
    const payee = await User.findById(to).select(
      "firstName lastName username"
    );

    if (!payee) {
      return res.status(404).json({
        message: "Payee not found",
      });
    }

    // Verify payment PIN
    const pinResult = await checkPin(payerId, pin);

    if (!pinResult.ok) {
      return res.status(pinResult.status || 403).json({
        message: pinResult.error || "Wrong PIN",
        triesLeft: pinResult.attemptsRemaining,
      });
    }

    // Maximum 5 non-cancelled AutoPays per user
    const activeCount = await Mandate.countDocuments({
      payerId,
      status: { $ne: "CANCELLED" },
    });

    if (activeCount >= 5) {
      return res.status(409).json({
        message: "You can have at most 5 AutoPays",
      });
    }

    // Create AutoPay mandate
    const mandate = await Mandate.create({
      payerId,
      payeeId: payee._id,
      amount,
      dayOfMonth,
      status: "ACTIVE",
      nextRunDay: getNextRunDay(dayOfMonth),
      failedCount: 0,
    });

    return res.status(201).json({
      message: "AutoPay set up",
      mandate: {
        id: mandate._id,
        to: `${payee.firstName || ""} ${payee.lastName || ""}`.trim(),
        amount: mandate.amount,
        dayOfMonth: mandate.dayOfMonth,
        status: mandate.status,
        nextRunDay: mandate.nextRunDay,
      },
    });
  } catch (error) {
    console.error("AutoPay setup error:", error);

    return res.status(500).json({
      message: "Unable to set up AutoPay",
    });
  }
});


// GET all AutoPay mandates for the logged-in user
router.get("/", authMiddleware, async (req, res) => {
  try {
    const mandates = await Mandate.find({
      payerId: req.user.userId,
    })
      .populate("payeeId", "firstName lastName username email")
      .sort({ createdAt: -1 });

    return res.json({ mandates });
  } catch (error) {
    console.error("AutoPay list error:", error);
    return res.status(500).json({ error: "Unable to fetch AutoPay mandates" });
  }
});

// GET payment history for one mandate
router.get("/:id/runs", authMiddleware, async (req, res) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
      return res.status(400).json({ error: "Invalid AutoPay ID" });
    }

    const mandate = await Mandate.findOne({
      _id: req.params.id,
      payerId: req.user.userId,
    });

    if (!mandate) {
      return res.status(404).json({ error: "AutoPay mandate not found" });
    }

    const MandateRun = require("../models/MandateRun");

    const runs = await MandateRun.find({
      mandateId: mandate._id,
    }).sort({ createdAt: -1 }).limit(100);

    return res.json({ runs });
  } catch (error) {
    console.error("AutoPay history error:", error);
    return res.status(500).json({ error: "Unable to fetch payment history" });
  }
});

// PAUSE AutoPay
router.post("/:id/pause", authMiddleware, async (req, res) => {
  try {
    const mandate = await Mandate.findOneAndUpdate(
      {
        _id: req.params.id,
        payerId: req.user.userId,
        status: "ACTIVE",
      },
      { $set: { status: "PAUSED" } },
      { new: true }
    );

    if (!mandate) {
      return res.status(404).json({
        error: "Active AutoPay mandate not found",
      });
    }

    return res.json({ message: "AutoPay paused", mandate });
  } catch (error) {
    console.error("AutoPay pause error:", error);
    return res.status(500).json({ error: "Unable to pause AutoPay" });
  }
});

// RESUME AutoPay
router.post("/:id/resume", authMiddleware, async (req, res) => {
  try {
    const existing = await Mandate.findOne({
      _id: req.params.id,
      payerId: req.user.userId,
      status: "PAUSED",
    });

    if (!existing) {
      return res.status(404).json({
        error: "Paused AutoPay mandate not found",
      });
    }

    const updated = await Mandate.findOneAndUpdate(
      {
        _id: existing._id,
        payerId: req.user.userId,
        status: "PAUSED",
      },
      {
        $set: {
          status: "ACTIVE",
          failedCount: 0,
          nextRunDay: getNextRunDay(existing.dayOfMonth),
        },
      },
      { new: true }
    );

    if (!updated) {
      return res.status(409).json({
        error: "AutoPay status changed. Please try again.",
      });
    }

    return res.json({ message: "AutoPay resumed", mandate: updated });
  } catch (error) {
    console.error("AutoPay resume error:", error);
    return res.status(500).json({ error: "Unable to resume AutoPay" });
  }
});

// CANCEL AutoPay
router.post("/:id/cancel", authMiddleware, async (req, res) => {
  try {
    const mandate = await Mandate.findOneAndUpdate(
      {
        _id: req.params.id,
        payerId: req.user.userId,
        status: { $ne: "CANCELLED" },
      },
      { $set: { status: "CANCELLED" } },
      { new: true }
    );

    if (!mandate) {
      return res.status(404).json({
        error: "AutoPay mandate not found or already cancelled",
      });
    }

    return res.json({ message: "AutoPay cancelled", mandate });
  } catch (error) {
    console.error("AutoPay cancel error:", error);
    return res.status(500).json({ error: "Unable to cancel AutoPay" });
  }
});


module.exports = router;
