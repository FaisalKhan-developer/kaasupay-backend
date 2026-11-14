
const bcrypt = require("bcryptjs");
const User = require("../models/User");

const MAX_FAILED_ATTEMPTS = 3;
const LOCK_DURATION_MS = 15 * 60 * 1000;

async function checkPin(userId, pin) {
  let now = new Date();

  let currentUser = await User.findById(userId).select(
    "pinHash pinFailedCount pinLockedUntil"
  );

  if (!currentUser || !currentUser.pinHash) {
    return {
      ok: false,
      status: 400,
      error: "Payment PIN has not been set",
    };
  }

  // Reject attempts while the PIN is locked.
  if (
    currentUser.pinLockedUntil &&
    currentUser.pinLockedUntil > now
  ) {
    return {
      ok: false,
      status: 423,
      error: "Payment PIN is temporarily locked",
      retryAfter: Math.ceil(
        (currentUser.pinLockedUntil.getTime() - now.getTime()) / 1000
      ),
    };
  }

  // Reset the counter after an existing lock has expired.
  if (
    currentUser.pinLockedUntil &&
    currentUser.pinLockedUntil <= now
  ) {
    await User.updateOne(
      {
        _id: userId,
        pinLockedUntil: { $lte: now },
      },
      {
        $set: {
          pinFailedCount: 0,
          pinLockedUntil: null,
        },
      }
    );

    currentUser = await User.findById(userId).select(
      "pinHash pinFailedCount pinLockedUntil"
    );

    if (!currentUser) {
      return {
        ok: false,
        status: 400,
        error: "User not found",
      };
    }
  }

  // If three attempts were reserved but no lock timestamp was saved,
  // establish the lock instead of allowing another attempt.
  if ((currentUser.pinFailedCount || 0) >= MAX_FAILED_ATTEMPTS) {
    const lockedUntil = new Date(Date.now() + LOCK_DURATION_MS);

    await User.updateOne(
      {
        _id: userId,
        pinFailedCount: { $gte: MAX_FAILED_ATTEMPTS },
        $or: [
          { pinLockedUntil: null },
          { pinLockedUntil: { $exists: false } },
        ],
      },
      {
        $set: { pinLockedUntil: lockedUntil },
      }
    );

    const latestUser = await User.findById(userId).select(
      "pinLockedUntil"
    );

    const retryAfter = latestUser?.pinLockedUntil
      ? Math.max(
          1,
          Math.ceil(
            (latestUser.pinLockedUntil.getTime() - Date.now()) / 1000
          )
        )
      : Math.ceil(LOCK_DURATION_MS / 1000);

    return {
      ok: false,
      status: 423,
      error: "Payment PIN is temporarily locked",
      retryAfter,
    };
  }

  // Atomically reserve one attempt before checking the PIN.
  const reservedUser = await User.findOneAndUpdate(
    {
      _id: userId,
      pinHash: currentUser.pinHash,
      pinFailedCount: { $lt: MAX_FAILED_ATTEMPTS },
      $or: [
        { pinLockedUntil: null },
        { pinLockedUntil: { $exists: false } },
        { pinLockedUntil: { $lte: new Date() } },
      ],
    },
    {
      $inc: { pinFailedCount: 1 },
    },
    {
      returnDocument: "after",
      projection: {
        pinHash: 1,
        pinFailedCount: 1,
        pinLockedUntil: 1,
      },
    }
  );

  if (!reservedUser) {
    return {
      ok: false,
      status: 423,
      error: "Unable to verify Payment PIN. Please try again.",
    };
  }

  const pinMatches = await bcrypt.compare(pin, reservedUser.pinHash);

  if (!pinMatches) {
    // The third incorrect attempt starts the 15-minute lock.
    if (reservedUser.pinFailedCount >= MAX_FAILED_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + LOCK_DURATION_MS);

      await User.updateOne(
        {
          _id: userId,
          pinFailedCount: { $gte: MAX_FAILED_ATTEMPTS },
          $or: [
            { pinLockedUntil: null },
            { pinLockedUntil: { $exists: false } },
          ],
        },
        {
          $set: { pinLockedUntil: lockedUntil },
        }
      );

      const latestUser = await User.findById(userId).select(
        "pinLockedUntil"
      );

      return {
        ok: false,
        status: 423,
        error: "Too many incorrect PIN attempts. Try again in 15 minutes.",
        retryAfter: latestUser?.pinLockedUntil
          ? Math.max(
              1,
              Math.ceil(
                (latestUser.pinLockedUntil.getTime() - Date.now()) / 1000
              )
            )
          : Math.ceil(LOCK_DURATION_MS / 1000),
      };
    }

    return {
      ok: false,
      status: 403,
      error: "Incorrect Payment PIN",
      attemptsRemaining:
        MAX_FAILED_ATTEMPTS - reservedUser.pinFailedCount,
    };
  }

  // Check that another concurrent attempt has not locked the PIN.
  const latestUser = await User.findById(userId).select(
    "pinFailedCount pinLockedUntil"
  );

  if (
    !latestUser ||
    (latestUser.pinLockedUntil &&
      latestUser.pinLockedUntil > new Date())
  ) {
    return {
      ok: false,
      status: 423,
      error: "Payment PIN is temporarily locked",
    };
  }

  // Reset failed attempts after a successful PIN verification.
  await User.updateOne(
    {
      _id: userId,
      pinLockedUntil: null,
    },
    {
      $set: {
        pinFailedCount: 0,
        pinLockedUntil: null,
      },
    }
  );

  return { ok: true };
}

module.exports = { checkPin };