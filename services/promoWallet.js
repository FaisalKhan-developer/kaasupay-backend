
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Wallet = require("../models/Wallet");

const PROMO_USERNAME = "kaasupay-promo@system.internal";

async function getOrCreatePromoWallet(session) {
  let promoUser = await User.findOne({
    username: PROMO_USERNAME,
  }).session(session);

  if (!promoUser) {
    const passwordHash = await bcrypt.hash(
      require("crypto").randomBytes(48).toString("hex"),
      12
    );

    [promoUser] = await User.create(
      [
        {
          username: PROMO_USERNAME,
          firstName: "KaasuPay",
          lastName: "Promotions",
          passwordHash,
        },
      ],
      { session }
    );
  }

  let promoWallet = await Wallet.findOne({
    user: promoUser._id,
  }).session(session);

  if (!promoWallet) {
    [promoWallet] = await Wallet.create(
      [
        {
          user: promoUser._id,
          balance: 0,
        },
      ],
      { session }
    );
  }

  return { promoUser, promoWallet };
}

module.exports = { getOrCreatePromoWallet };

