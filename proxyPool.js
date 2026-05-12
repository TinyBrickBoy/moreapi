class ProxyPool {
  constructor(cooldownMs) {
    this.entries = [];
    this.cooldownMs = cooldownMs;
    this.cursor = 0;
  }

  setProxies(incoming, { keepRecentlyUsedMs = 30 * 60 * 1000 } = {}) {
    const normalized = incoming.map((e) =>
      typeof e === 'string'
        ? { url: e, pingMs: null }
        : { url: e.url, pingMs: e.pingMs ?? null, successes: e.successes ?? 0 },
    );
    const incomingUrls = new Set(normalized.map((n) => n.url));
    const byUrl = new Map(this.entries.map((e) => [e.url, e]));

    const merged = normalized.map((n) => {
      const old = byUrl.get(n.url);
      if (old) {
        return {
          ...old,
          pingMs: n.pingMs ?? old.pingMs,
          successes: Math.max(old.successes ?? 0, n.successes ?? 0),
        };
      }
      return {
        url: n.url,
        pingMs: n.pingMs,
        successes: n.successes ?? 0,
        cooldownUntil: 0,
        fails: 0,
      };
    });

    const cutoff = Date.now() - keepRecentlyUsedMs;
    for (const old of this.entries) {
      if (incomingUrls.has(old.url)) continue;
      if (old.lastUsed && old.lastUsed > cutoff) merged.push(old);
    }

    this.entries = merged.sort((a, b) => {
      const pa = a.pingMs ?? Infinity;
      const pb = b.pingMs ?? Infinity;
      return pa - pb;
    });
    if (this.cursor >= this.entries.length) this.cursor = 0;
  }

  pick() {
    if (this.entries.length === 0) return null;
    const now = Date.now();
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[this.cursor % this.entries.length];
      this.cursor = (this.cursor + 1) % this.entries.length;
      if (entry.cooldownUntil <= now) return entry;
    }
    return null;
  }

  cooldown(entry, reason) {
    entry.cooldownUntil = Date.now() + this.cooldownMs;
    entry.fails += 1;
    const until = new Date(entry.cooldownUntil).toISOString();
    console.warn(`[pool] cooldown ${entry.url} until ${until} (${reason})`);
  }

  recordSuccess(entry, pingMs) {
    entry.pingMs = entry.pingMs == null
      ? pingMs
      : Math.round(entry.pingMs * 0.7 + pingMs * 0.3);
    entry.lastUsed = Date.now();
    entry.successes = (entry.successes ?? 0) + 1;
  }

  upsert({ url, pingMs }) {
    const existing = this.entries.find((e) => e.url === url);
    if (existing) {
      existing.pingMs = pingMs;
      existing.cooldownUntil = 0;
      return existing;
    }
    const entry = { url, pingMs, cooldownUntil: 0, fails: 0, successes: 0 };
    this.entries.push(entry);
    return entry;
  }

  resort() {
    this.entries.sort((a, b) => {
      const pa = a.pingMs ?? Infinity;
      const pb = b.pingMs ?? Infinity;
      return pa - pb;
    });
  }

  serializable() {
    return this.entries
      .filter((e) => e.pingMs !== null && e.pingMs !== undefined)
      .map((e) => ({ url: e.url, pingMs: e.pingMs, successes: e.successes ?? 0 }));
  }

  status() {
    const now = Date.now();
    return this.entries.map((e) => ({
      url: e.url,
      pingMs: e.pingMs,
      available: e.cooldownUntil <= now,
      cooldownRemainingMs: Math.max(0, e.cooldownUntil - now),
      fails: e.fails,
      successes: e.successes ?? 0,
      lastUsed: e.lastUsed ?? null,
    }));
  }
}

module.exports = { ProxyPool };
