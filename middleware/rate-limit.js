function createRateLimiter({ limit, windowMs, message }) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs < 1) {
    throw new Error("Rate limiter requires a positive limit and window.");
  }
  const buckets = new Map();
  return function rateLimit(req, res, next) {
    const now = Date.now();
    if (buckets.size > 5000) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
    }
    const key = String(req.ip || req.socket?.remoteAddress || "unknown");
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
    }
    if (bucket.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ error: message, retry_after_seconds: retryAfter });
    }
    bucket.count += 1;
    buckets.set(key, bucket);
    next();
  };
}

module.exports = { createRateLimiter };
