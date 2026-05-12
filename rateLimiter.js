class RateLimiter {
  constructor() {
    this.windows = new Map();
  }

  check(key, requests, windowMs) {
    if (!requests || !windowMs) return { ok: true };
    const now = Date.now();
    const cutoff = now - windowMs;
    const list = (this.windows.get(key) || []).filter((t) => t > cutoff);
    if (list.length >= requests) {
      return { ok: false, retryAfterMs: list[0] + windowMs - now };
    }
    list.push(now);
    this.windows.set(key, list);
    return { ok: true };
  }
}

module.exports = { RateLimiter };
