
require("dotenv").config();

const mongoose = require("mongoose");
const LedgerEntry = require("../models/LedgerEntry");
require("../models/Transaction");

async function backfillLedgerTypes() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);

    console.log("Connected to MongoDB");

    const entries = await LedgerEntry.find({
      $or: [
        { type: { $exists: false } },
        { type: null },
      ],
    }).select("_id transactionId");

    console.log(`Found ${entries.length} ledger entries to update`);

    let updated = 0;
    let skipped = 0;

    for (const entry of entries) {
      const transaction = await mongoose
        .model("Transaction")
        .findById(entry.transactionId)
        .select("type");

      if (!transaction) {
        console.log(`Transaction not found: ${entry.transactionId}`);
        skipped++;
        continue;
      }

      await LedgerEntry.updateOne(
        {
          _id: entry._id,
          $or: [
            { type: { $exists: false } },
            { type: null },
          ],
        },
        {
          $set: { type: transaction.type },
        }
      );

      updated++;
    }

    console.log("Backfill completed");
    console.log(`Updated: ${updated}`);
    console.log(`Skipped: ${skipped}`);
  } catch (error) {
    console.error("Backfill failed:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

backfillLedgerTypes();
