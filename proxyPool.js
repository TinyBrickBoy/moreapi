class ProxyPool {
  constructor(proxies, cooldownMs) {
    this.entries = proxies.map((url) => ({ url, cooldownUntil: 0, fails: 0 }));
    this.cooldownMs = cooldownMs;
    this.cursor = 0;
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

  status() {
    const now = Date.now();
    return this.entries.map((e) => ({
      url: e.url,
      available: e.cooldownUntil <= now,
      cooldownRemainingMs: Math.max(0, e.cooldownUntil - now),
      fails: e.fails,
    }));
  }
}

module.exports = { ProxyPool };
