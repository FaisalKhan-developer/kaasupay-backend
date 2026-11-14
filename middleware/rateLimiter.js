const RateLimitCounter = require("../models/RateLimitCounter");

function createRateLimiter({
  keyGenerator,
  limit,
  windowMs,
  message = "Too many requests. Please try again later.",
}) {
  return async function rateLimiter(req, res, next) {
    try {
      const identity = keyGenerator(req);
      const now = new Date();

      const bucket = Math.floor(now.getTime() / windowMs);
      const key = `${identity}:${bucket}`;

      const expiresAt = new Date((bucket + 1) * windowMs);

      // Ensure the counter document exists.
      try {
        await RateLimitCounter.updateOne(
          { key },
          {
            $setOnInsert: {
              count: 0,
              expiresAt,
            },
          },
          { upsert: true }
        );
      } catch (error) {
        // Another simultaneous request may have created it.
        if (error.code !== 11000) {
          throw error;
        }
      }

      // Atomically increment only while below the limit.
      const counter = await RateLimitCounter.findOneAndUpdate(
        {
          key,
          count: { $lt: limit },
        },
        {
          $inc: { count: 1 },
        },
        { new: true }
      );

      const retryAfter = Math.max(
        1,
        Math.ceil((expiresAt.getTime() - now.getTime()) / 1000)
      );

      res.set("X-RateLimit-Limit", String(limit));
      res.set(
        "X-RateLimit-Remaining",
        String(counter ? Math.max(0, limit - counter.count) : 0)
      );

      if (!counter) {
        res.set("Retry-After", String(retryAfter));

        return res.status(429).json({
          error: message,
          retryAfter,
        });
      }

      next();
    } catch (error) {
      console.error("Rate limiter error:", error);

      return res.status(503).json({
        error: "Request protection temporarily unavailable",
      });
    }
  };
}

module.exports = { createRateLimiter };
