
const express = require("express");
const { z } = require("zod");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { JWT_SECRET } = require("../config");
const LedgerEntry = require("../models/LedgerEntry");

const router = express.Router();

const TYPES = [
  "DEPOSIT",
  "TRANSFER",
  "TOPUP",
  "WITHDRAWAL",
  "REVERSAL",
];

function indiaDateStart(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);

  // India is UTC+05:30
  return new Date(Date.UTC(year, month - 1, day) - 330 * 60 * 1000);
}

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const date = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

router.get("/", async (req, res) => {
  // 1. Authentication
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

  // 2. Validate query parameters
  const querySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().optional(),
    direction: z.enum(["DEBIT", "CREDIT"]).optional(),
    type: z.enum(TYPES).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  });

  const parsed = querySchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid inputs",
    });
  }

  const { limit, cursor, direction, type, from, to } = parsed.data;

  // 3. Validate India calendar dates
  if (
    (from && !isValidDateString(from)) ||
    (to && !isValidDateString(to))
  ) {
    return res.status(400).json({
      error: "Dates must use valid YYYY-MM-DD format",
    });
  }

  if (from && to && from > to) {
    return res.status(400).json({
      error: "from must not be after to",
    });
  }

  try {
    const conditions = [
      { userId: decoded.userId },
    ];

    if (direction) {
      conditions.push({ direction });
    }

    if (type) {
      conditions.push({ type });
    }

    // 4. India date filtering
    if (from || to) {
      const dateFilter = {};

      if (from) {
        dateFilter.$gte = indiaDateStart(from);
      }

      if (to) {
        const nextDay = new Date(
          `${to}T00:00:00Z`
        );
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);

        dateFilter.$lt = new Date(
          nextDay.getTime() - 330 * 60 * 1000
        );
      }

      conditions.push({ createdAt: dateFilter });
    }

    // 5. Decode cursor
    if (cursor) {
      let cursorData;

      try {
        cursorData = JSON.parse(
          Buffer.from(cursor, "base64url").toString("utf8")
        );

        if (
          !cursorData.t ||
          !cursorData.id ||
          !mongoose.isValidObjectId(cursorData.id) ||
          Number.isNaN(new Date(cursorData.t).getTime())
        ) {
          throw new Error("Invalid cursor");
        }
      } catch {
        return res.status(400).json({
          error: "Invalid cursor",
        });
      }

      const lastTime = new Date(cursorData.t);

      conditions.push({
        $or: [
          { createdAt: { $lt: lastTime } },
          {
            createdAt: lastTime,
            _id: { $lt: new mongoose.Types.ObjectId(cursorData.id) },
          },
        ],
      });
    }

    const filter = { $and: conditions };

    // 6. Fetch one extra entry
    const entries = await LedgerEntry.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .populate({
        path: "transactionId",
        select: "fromUserId toUserId note createdAt",
        populate: [
          { path: "fromUserId", select: "firstName lastName" },
          { path: "toUserId", select: "firstName lastName" },
        ],
      })
      .lean();

    const hasMore = entries.length > limit;
    const pageEntries = entries.slice(0, limit);

    // 7. Format passbook entries
    const data = pageEntries.map((entry) => {
      const transaction = entry.transactionId;

      let withWhom = "Bank deposit";

      if (entry.type === "TRANSFER") {
        const otherUser =
          entry.direction === "DEBIT"
            ? transaction?.toUserId
            : transaction?.fromUserId;

        withWhom = otherUser
          ? `${otherUser.firstName} ${otherUser.lastName}`.trim()
          : "Unknown user";
      }

      return {
        id: entry._id,
        transactionId: transaction?._id,
        type: entry.type,
        label: entry.type,
        direction: entry.direction,
        amount: entry.amount,
        withWhom,
        note: transaction?.note || "",
        balanceAfter: entry.balanceAfter,
        createdAt: entry.createdAt,
        at: entry.createdAt,
      };
    });

    // 8. Generate next cursor
    let nextCursor = null;

    if (hasMore && pageEntries.length > 0) {
      const lastEntry = pageEntries[pageEntries.length - 1];

      nextCursor = Buffer.from(
        JSON.stringify({
          t: lastEntry.createdAt,
          id: lastEntry._id.toString(),
        })
      ).toString("base64url");
    }

    return res.status(200).json({
      data,
      nextCursor,
    });
  } catch (error) {
    console.error("Passbook error:", error);

    return res.status(500).json({
      error: "Failed to fetch transaction history",
    });
  }
});

module.exports = router;
