const express = require("express");

const userRouter = require("./user");
const addMoneyRouter = require("./addMoney");
const transactionsRouter = require("./transactions");
const adminRouter = require("./admin");
const walletRouter = require("./wallet");
const withdrawalsRouter = require("./withdrawals");

const router = express.Router();

// User routes
router.use("/user", userRouter);

// Admin routes
router.use("/admin", adminRouter);

// Wallet routes
router.use("/wallet", walletRouter);
router.use("/wallet/transactions", transactionsRouter);
router.use("/wallet/add-money", addMoneyRouter);

// Withdrawal and bank account routes
router.use("/wallet", withdrawalsRouter);

module.exports = router;