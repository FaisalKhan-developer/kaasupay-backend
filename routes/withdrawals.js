
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config");

const BankAccount = require("../models/bankAccount");
const Withdrawal = require("../models/Withdrawal");
const { requestWithdrawal } = require("../services/money");

const router = express.Router();
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing authentication token" });
  }

  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    req.user = { userId: decoded.userId };
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Save a bank account
router.post("/bank-accounts", async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id || req.user?._id;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { holderName, accountNumber, ifsc } = req.body;

    if (
      typeof holderName !== "string" ||
      typeof accountNumber !== "string" ||
      typeof ifsc !== "string" ||
      !holderName.trim() ||
      !/^\d{9,18}$/.test(accountNumber) ||
      !/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(ifsc.trim())
    ) {
      return res.status(400).json({
        error: "Valid holderName, accountNumber and IFSC are required",
      });
    }

    const normalizedIfsc = ifsc.trim().toUpperCase();

    const existing = await BankAccount.findOne({
      userId,
      accountNumber,
    }).select("+accountNumber");

    if (existing) {
      return res.status(409).json({
        error: "This bank account is already saved",
      });
    }

    const bankAccount = await BankAccount.create({
      userId,
      holderName: holderName.trim(),
      accountNumber,
      ifsc: normalizedIfsc,
      last4: accountNumber.slice(-4),
    });

    return res.status(201).json({
      message: "Bank account saved",
      bankAccount: {
        id: bankAccount._id,
        holderName: bankAccount.holderName,
        last4: bankAccount.last4,
        ifsc: bankAccount.ifsc,
      },
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        error: "This bank account is already saved",
      });
    }

    console.error("Save bank account error:", error);
    return res.status(500).json({ error: "Unable to save bank account" });
  }
});

// List the logged-in user's bank accounts
router.get("/bank-accounts", authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id || req.user?._id;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const accounts = await BankAccount.find({ userId }).select(
      "holderName last4 ifsc createdAt"
    );

    return res.json({ bankAccounts: accounts });
  } catch (error) {
    console.error("List bank accounts error:", error);
    return res.status(500).json({ error: "Unable to list bank accounts" });
  }
});

// Request a withdrawal
router.post("/bank-accounts", authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id || req.user?._id;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { bankAccountId, amount } = req.body;
    const idempotencyKey = req.get("Idempotency-Key");

    if (!mongoose.isValidObjectId(bankAccountId)) {
      return res.status(400).json({ error: "Valid bankAccountId is required" });
    }

    if (!Number.isSafeInteger(amount)) {
      return res.status(400).json({
        error: "Amount must be a whole number in paise",
      });
    }

    const result = await requestWithdrawal({
      userId,
      bankAccountId,
      amount,
      idempotencyKey,
    });

    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Request withdrawal error:", error);
    return res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to request withdrawal",
    });
  }
});

// List the logged-in user's withdrawals
router.get("/withdrawals", authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id || req.user?._id;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const withdrawals = await Withdrawal.find({ userId })
      .select("-__v")
      .sort({ createdAt: -1 })
      .limit(50);

    return res.json({ withdrawals });
  } catch (error) {
    console.error("List withdrawals error:", error);
    return res.status(500).json({ error: "Unable to list withdrawals" });
  }
});

// Get one withdrawal
router.get("/withdrawals/:id", authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id || req.user?._id;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid withdrawal ID" });
    }

    const withdrawal = await Withdrawal.findOne({
      _id: req.params.id,
      userId,
    }).select("-__v");

    if (!withdrawal) {
      return res.status(404).json({ error: "Withdrawal not found" });
    }

    return res.json({ withdrawal });
  } catch (error) {
    console.error("Get withdrawal error:", error);
    return res.status(500).json({ error: "Unable to get withdrawal" });
  }
});


router.get("/admin/withdrawals", async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;

  if (
    !adminKey ||
    typeof req.get("x-admin-key") !== "string" ||
    req.get("x-admin-key") !== adminKey
  ) {
    return res.status(401).json({ error: "Staff only" });
  }

  try {
    const status = req.query.status || "NEEDS_REVIEW";

    const allowedStatuses = [
      "PENDING",
      "PROCESSING",
      "SUCCESS",
      "REVERSED",
      "NEEDS_REVIEW",
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid withdrawal status" });
    }

    const withdrawals = await Withdrawal.find({ status })
      .select("-__v")
      .sort({ createdAt: -1 })
      .limit(100);

    return res.json({ withdrawals });
  } catch (error) {
    console.error("Admin withdrawal review error:", error);
    return res.status(500).json({
      error: "Unable to retrieve withdrawals",
    });
  }
});


router.get("/admin/withdrawals", async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;

  if (
    !adminKey ||
    typeof req.get("x-admin-key") !== "string" ||
    req.get("x-admin-key") !== adminKey
  ) {
    return res.status(401).json({ error: "Staff only" });
  }

  try {
    const status = req.query.status || "NEEDS_REVIEW";

    const allowedStatuses = [
      "PENDING",
      "PROCESSING",
      "SUCCESS",
      "REVERSED",
      "NEEDS_REVIEW",
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid withdrawal status" });
    }

    const withdrawals = await Withdrawal.find({ status })
      .select("-__v")
      .sort({ createdAt: -1 })
      .limit(100);

    return res.json({ withdrawals });
  } catch (error) {
    console.error("Admin withdrawal review error:", error);
    return res.status(500).json({
      error: "Unable to retrieve withdrawals",
    });
  }
});



module.exports = router;
