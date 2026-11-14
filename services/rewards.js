const Offer = require("../models/Offer");
const RewardCard = require("../models/RewardCard");
const RewardCount = require("../models/RewardCount");
const Transaction = require("../models/Transaction");

function getIndiaDay() {
  const indiaTime = new Date(Date.now() + 330 * 60 * 1000);
  return indiaTime.toISOString().slice(0, 10);
}

async function createRewardCard({
  userId,
  receiverId,
  transactionId,
  amount,
  session,
}) {
  const now = new Date();

  // Prevent duplicate reward cards for one payment.
  const existingCard = await RewardCard.findOne({
    transactionId,
  }).session(session);

  if (existingCard) return;

  // Find an active offer for this payment.
  const offer = await Offer.findOne({
    startsAt: { $lte: now },
    endsAt: { $gt: now },
    minPayment: { $lte: amount },
  })
    .sort({ startsAt: -1 })
    .session(session);

  if (!offer) return;

  // Do not reward if the receiver recently paid the sender.
  const reverseTransfer = await Transaction.findOne({
    type: "TRANSFER",
    fromUserId: receiverId,
    toUserId: userId,
    createdAt: {
      $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    },
  }).session(session);

  if (reverseTransfer) return;

  // Maximum three reward cards per user per India day.
  const day = getIndiaDay();

await RewardCount.updateOne(
  { userId, day },
  { $setOnInsert: { cards: 0 } },
  { upsert: true, session }
);

const count = await RewardCount.findOneAndUpdate(
  {
    userId,
    day,
    cards: { $lt: 3 },
  },
  {
    $inc: { cards: 1 },
  },
  {
    new: true,
    session,
  }
);

if (!count) return;

  // Calculate cashback in paise.
  const rewardAmount = Math.min(
    Math.floor((amount * offer.percent) / 100),
    offer.maxCashback
  );

  if (rewardAmount <= 0) return;

  await RewardCard.create(
    [
      {
        userId,
        offerId: offer._id,
        transactionId,
        amount: rewardAmount,
        status: "UNCLAIMED",
        expiresAt: new Date(
          now.getTime() + 7 * 24 * 60 * 60 * 1000
        ),
      },
    ],
    { session }
  );
}

module.exports = { createRewardCard };