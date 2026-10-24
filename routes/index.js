
const express = require("express");

const userRouter = require("./user");
const addMoneyRouter = require("./addMoney");
const transactionsRouter = require("./transactions");
const adminRouter = require("./admin");
const walletRouter = require("./wallet");
const withdrawalsRouter = require("./withdrawals");

const router = express.Router();

router.use("/user", userRouter);
router.use("/admin", adminRouter);

// Wallet endpoints
router.use("/wallet", walletRouter);
router.use("/wallet/transactions", transactionsRouter);
router.use("/wallet/add-money", addMoneyRouter);
router.use("/wallet", withdrawalsRouter);

module.exports = router;
