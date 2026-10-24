
const mongoose = require("mongoose");

const idempotencyRecordSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    key: {
      type: String,
      required: true,
      trim: true,
    },
    requestHash: {
      type: String,
      required: true,
    },
    state: {
      type: String,
      enum: ["IN_PROGRESS", "DONE"],
      required: true,
      default: "IN_PROGRESS",
    },
    responseStatus: {
      type: Number,
      default: null,
    },
    responseBody: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// A user cannot reuse the same idempotency key for a second record.
idempotencyRecordSchema.index(
  { userId: 1, key: 1 },
  { unique: true }
);

module.exports = mongoose.model(
  "IdempotencyRecord",
  idempotencyRecordSchema
);
