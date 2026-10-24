
const express = require("express");
const { z } = require("zod");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config");
const LedgerEntry = require("../models/LedgerEntry");

const router = express.Router();

router.get("/", async (req, res) => {
  // 1. Verify the user's login token
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

  // 2. Validate pagination parameters
  const querySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  });

  const parsed = querySchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(", "),
    });
  }

  const { page, limit } = parsed.data;

  try {
    // 3. Find only this user's passbook entries
    const filter = { userId: decoded.userId };

    const [entries, total] = await Promise.all([
      LedgerEntry.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate({
          path: "transactionId",
          select: "type fromUserId toUserId note createdAt",
          populate: [
            { path: "fromUserId", select: "firstName lastName" },
            { path: "toUserId", select: "firstName lastName" },
          ],
        })
        .lean(),

      LedgerEntry.countDocuments(filter),
    ]);

    // 4. Format passbook lines
    const data = entries.map((entry) => {
      const transaction = entry.transactionId;

      let withWhom = "Bank deposit";

      if (transaction?.type === "TRANSFER") {
        const otherUser =
          entry.direction === "DEBIT"
            ? transaction.toUserId
            : transaction.fromUserId;

        withWhom = otherUser
          ? `${otherUser.firstName} ${otherUser.lastName}`.trim()
          : "Unknown user";
      }

      return {
        transactionId: transaction?._id,
        type: transaction?.type,
        direction: entry.direction,
        amount: entry.amount,
        withWhom,
        note: transaction?.note || "",
        balanceAfter: entry.balanceAfter,
        createdAt: entry.createdAt,
      };
    });

    return res.status(200).json({
      data,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("Passbook error:", error);
    return res.status(500).json({
      error: "Failed to fetch transaction history",
    });
  }
});

module.exports = router;
