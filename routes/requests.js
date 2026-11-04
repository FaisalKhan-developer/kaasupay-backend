const express = require("express");
const mongoose = require("mongoose");
const { z } = require("zod");
const jwt = require("jsonwebtoken");

const { JWT_SECRET, REQUEST_EXPIRY_DAYS } = require("../config");

const User = require("../models/User");
const MoneyRequest = require("../models/MoneyRequest");

const { createRateLimiter } = require("../middleware/rateLimiter");
const { checkPin } = require("../services/pin");
const { payMoneyRequest } = require("../services/money");

const router = express.Router();

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

    const user = await User.findById(decoded.userId).select("tokenVersion");

    if (!user || (decoded.tv ?? 0) !== (user.tokenVersion ?? 0)) {
      return res.status(401).json({
        error: "Session expired. Please log in again.",
      });
    }

    req.user = { userId: user._id };
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

    console.error("Request authentication error:", error);

    return res.status(500).json({
      error: "Authentication failed",
    });
  }
});

// ================= RATE LIMITERS =================

const createRequestLimiter = createRateLimiter({
  keyGenerator: (req) => `request-create:${req.user.userId}`,
  limit: 20,
  windowMs: 60 * 60 * 1000,
  message: "Too many money requests. Try again later.",
});

const paymentLimiter = createRateLimiter({
  keyGenerator: (req) => `money:${req.user.userId}`,
  limit: 10,
  windowMs: 60 * 1000,
  message: "Too many money transactions. Try again later.",
});

// ================= HELPERS =================

const validId = (id) => mongoose.isValidObjectId(id);

const VALID_STATUSES = [
  "PENDING",
  "PAID",
  "DECLINED",
  "CANCELLED",
  "EXPIRED",
];

async function expireOldRequests(filter = {}) {
  const now = new Date();

  await MoneyRequest.updateMany(
    {
      ...filter,
      status: "PENDING",
      expiresAt: { $lte: now },
    },
    {
      $set: {
        status: "EXPIRED",
        decidedAt: now,
      },
    }
  );
}

async function getRequestForUser(id, userId) {
  if (!validId(id)) {
    return null;
  }

  return MoneyRequest.findOne({
    _id: id,
    $or: [
      { requesterId: userId },
      { payerId: userId },
    ],
  });
}

async function markRequestExpired(request) {
  const now = new Date();

  await MoneyRequest.updateOne(
    {
      _id: request._id,
      status: "PENDING",
      expiresAt: { $lte: now },
    },
    {
      $set: {
        status: "EXPIRED",
        decidedAt: now,
      },
    }
  );
}

// ================= CREATE REQUEST =================

// POST /api/v1/requests

router.post("/", createRequestLimiter, async (req, res) => {
  try {
    const schema = z.object({
      to: z.string().regex(/^[0-9a-fA-F]{24}$/),
      amount: z.number().int().min(100).max(1000000),
      note: z.string().trim().max(100).optional().default(""),
    });

    const parsed = schema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid request data",
        details: parsed.error.issues,
      });
    }

    const { to, amount, note } = parsed.data;
    const requesterId = req.user.userId;

    if (to.toLowerCase() === requesterId.toString()) {
      return res.status(400).json({
        error: "You cannot request money from yourself",
      });
    }

    const payer = await User.findById(to).select(
      "_id username firstName lastName"
    );

    if (!payer) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    await expireOldRequests({
      requesterId,
      payerId: payer._id,
    });

    // Maximum 5 pending requests to the same person.

    const pendingCount = await MoneyRequest.countDocuments({
      requesterId,
      payerId: payer._id,
      status: "PENDING",
    });

    if (pendingCount >= 5) {
      return res.status(409).json({
        error: "Maximum 5 pending requests to this person allowed",
      });
    }

    const expiresAt = new Date(
      Date.now() + REQUEST_EXPIRY_DAYS * 24 * 60 * 60 * 1000
    );

    const moneyRequest = await MoneyRequest.create({
      requesterId,
      payerId: payer._id,
      amount,
      note,
      expiresAt,
    });

    return res.status(201).json({
      message: "Money request created successfully",
      request: moneyRequest,
    });
  } catch (error) {
    console.error("Create money request error:", error);

    return res.status(500).json({
      error: "Could not create money request",
    });
  }
});

// ================= INCOMING REQUESTS =================

// GET /api/v1/requests/incoming

router.get("/incoming", async (req, res) => {
  try {
    const userId = req.user.userId;

    await expireOldRequests({ payerId: userId });

    const filter = {
      payerId: userId,
    };

    if (req.query.status) {
      if (!VALID_STATUSES.includes(req.query.status)) {
        return res.status(400).json({
          error: "Invalid status",
        });
      }

      filter.status = req.query.status;
    }

    const requests = await MoneyRequest.find(filter)
      .populate("requesterId", "username firstName lastName")
      .sort({ createdAt: -1 })
      .limit(20);

    return res.json({ requests });
  } catch (error) {
    console.error("Incoming requests error:", error);

    return res.status(500).json({
      error: "Could not fetch incoming requests",
    });
  }
});

// ================= OUTGOING REQUESTS =================

// GET /api/v1/requests/outgoing

router.get("/outgoing", async (req, res) => {
  try {
    const userId = req.user.userId;

    await expireOldRequests({ requesterId: userId });

    const filter = {
      requesterId: userId,
    };

    if (req.query.status) {
      if (!VALID_STATUSES.includes(req.query.status)) {
        return res.status(400).json({
          error: "Invalid status",
        });
      }

      filter.status = req.query.status;
    }

    const requests = await MoneyRequest.find(filter)
      .populate("payerId", "username firstName lastName")
      .sort({ createdAt: -1 })
      .limit(20);

    return res.json({ requests });
  } catch (error) {
    console.error("Outgoing requests error:", error);

    return res.status(500).json({
      error: "Could not fetch outgoing requests",
    });
  }
});

// ================= GET SINGLE REQUEST =================

// GET /api/v1/requests/:id

router.get("/:id", async (req, res) => {
  try {
    const request = await getRequestForUser(
      req.params.id,
      req.user.userId
    );

    if (!request) {
      return res.status(404).json({
        error: "Money request not found",
      });
    }

    if (
      request.status === "PENDING" &&
      request.expiresAt <= new Date()
    ) {
      await markRequestExpired(request);
    }

    await request.populate([
      {
        path: "requesterId",
        select: "username firstName lastName",
      },
      {
        path: "payerId",
        select: "username firstName lastName",
      },
    ]);

    return res.json({ request });
  } catch (error) {
    console.error("Get money request error:", error);

    return res.status(500).json({
      error: "Could not fetch money request",
    });
  }
});

// ================= DECLINE REQUEST =================

// POST /api/v1/requests/:id/decline

router.post("/:id/decline", async (req, res) => {
  try {
    const userId = req.user.userId;

    const request = await getRequestForUser(
      req.params.id,
      userId
    );

    if (!request) {
      return res.status(404).json({
        error: "Money request not found",
      });
    }

    if (request.payerId.toString() !== userId.toString()) {
      return res.status(403).json({
        error: "Only the payer can decline this request",
      });
    }

    const now = new Date();

    if (request.status === "EXPIRED") {
      return res.status(410).json({
        error: "Money request has expired",
      });
    }

    if (
      request.status === "PENDING" &&
      request.expiresAt <= now
    ) {
      await markRequestExpired(request);

      return res.status(410).json({
        error: "Money request has expired",
      });
    }

    const updated = await MoneyRequest.findOneAndUpdate(
      {
        _id: request._id,
        payerId: userId,
        status: "PENDING",
        expiresAt: { $gt: now },
      },
      {
        $set: {
          status: "DECLINED",
          decidedAt: now,
        },
      },
      { new: true }
    );

    if (!updated) {
      const latestRequest = await MoneyRequest.findById(request._id);

      if (!latestRequest) {
        return res.status(404).json({
          error: "Money request not found",
        });
      }

      if (
        latestRequest.status === "EXPIRED" ||
        (
          latestRequest.status === "PENDING" &&
          latestRequest.expiresAt <= new Date()
        )
      ) {
        await markRequestExpired(latestRequest);

        return res.status(410).json({
          error: "Money request has expired",
        });
      }

      return res.status(409).json({
        error: "Request is no longer pending",
      });
    }

    return res.json({
      message: "Money request declined",
      request: updated,
    });
  } catch (error) {
    console.error("Decline request error:", error);

    return res.status(500).json({
      error: "Could not decline request",
    });
  }
});

// ================= CANCEL REQUEST =================

// POST /api/v1/requests/:id/cancel

router.post("/:id/cancel", async (req, res) => {
  try {
    const userId = req.user.userId;

    const request = await getRequestForUser(
      req.params.id,
      userId
    );

    if (!request) {
      return res.status(404).json({
        error: "Money request not found",
      });
    }

    if (request.requesterId.toString() !== userId.toString()) {
      return res.status(403).json({
        error: "Only the requester can cancel this request",
      });
    }

    const now = new Date();

    if (request.status === "EXPIRED") {
      return res.status(410).json({
        error: "Money request has expired",
      });
    }

    if (
      request.status === "PENDING" &&
      request.expiresAt <= now
    ) {
      await markRequestExpired(request);

      return res.status(410).json({
        error: "Money request has expired",
      });
    }

    const updated = await MoneyRequest.findOneAndUpdate(
      {
        _id: request._id,
        requesterId: userId,
        status: "PENDING",
        expiresAt: { $gt: now },
      },
      {
        $set: {
          status: "CANCELLED",
          decidedAt: now,
        },
      },
      { new: true }
    );

    if (!updated) {
      const latestRequest = await MoneyRequest.findById(request._id);

      if (!latestRequest) {
        return res.status(404).json({
          error: "Money request not found",
        });
      }

      if (
        latestRequest.status === "EXPIRED" ||
        (
          latestRequest.status === "PENDING" &&
          latestRequest.expiresAt <= new Date()
        )
      ) {
        await markRequestExpired(latestRequest);

        return res.status(410).json({
          error: "Money request has expired",
        });
      }

      return res.status(409).json({
        error: "Request is no longer pending",
      });
    }

    return res.json({
      message: "Money request cancelled",
      request: updated,
    });
  } catch (error) {
    console.error("Cancel request error:", error);

    return res.status(500).json({
      error: "Could not cancel money request",
    });
  }
});

// ================= PAY REQUEST =================

// POST /api/v1/requests/:id/pay

router.post("/:id/pay", paymentLimiter, async (req, res) => {
  try {
    const schema = z.object({
      pin: z.string().regex(/^(\d{4}|\d{6})$/),
    });

    const parsed = schema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Valid payment PIN is required",
      });
    }

    const userId = req.user.userId;

    const request = await getRequestForUser(
      req.params.id,
      userId
    );

    if (!request) {
      return res.status(404).json({
        error: "Money request not found",
      });
    }

    if (request.payerId.toString() !== userId.toString()) {
      return res.status(403).json({
        error: "Only the payer can pay this request",
      });
    }

    if (request.status === "EXPIRED") {
      return res.status(410).json({
        error: "Money request has expired",
      });
    }

    if (
      request.status === "PENDING" &&
      request.expiresAt <= new Date()
    ) {
      await markRequestExpired(request);

      return res.status(410).json({
        error: "Money request has expired",
      });
    }

    const idempotencyKey = req.get("Idempotency-Key");

    if (
      !idempotencyKey ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 128
    ) {
      return res.status(400).json({
        error: "Valid Idempotency-Key header is required",
      });
    }

    // Verify PIN before idempotency handling.

    const pinResult = await checkPin(
      userId,
      parsed.data.pin
    );

    if (!pinResult.ok) {
      return res.status(pinResult.status).json({
        error: pinResult.error,
        ...(pinResult.retryAfter
          ? { retryAfter: pinResult.retryAfter }
          : {}),
        ...(pinResult.attemptsRemaining !== undefined
          ? { attemptsRemaining: pinResult.attemptsRemaining }
          : {}),
      });
    }

    // The service handles idempotency before checking request status.
    // This allows a successful payment to be safely retried.

    const result = await payMoneyRequest({
      payerId: userId,
      requestId: request._id,
      idempotencyKey,
    });

    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Pay money request error:", error);

    return res.status(error.status || 500).json({
      error: error.status
        ? error.message
        : "Could not pay money request",
    });
  }
});

module.exports = router;