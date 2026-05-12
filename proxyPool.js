class ProxyPool {
  constructor(cooldownMs) {
    this.entries = [];
    this.cooldownMs = cooldownMs;
    this.cursor = 0;
  }

  setProxies(incoming) {
    const normalized = incoming.map((e) =>
      typeof e === 'string' ? { url: e, pingMs: null } : { url: e.url, pingMs: e.pingMs ?? null },
    );
    const byUrl = new Map(this.entries.map((e) => [e.url, e]));
    this.entries = normalized
      .map((n) => {
        const old = byUrl.get(n.url);
        if (old) {
          return { ...old, pingMs: n.pingMs ?? old.pingMs };
        }
        return { url: n.url, pingMs: n.pingMs, cooldownUntil: 0, fails: 0 };
      })
      .sort((a, b) => {
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

  serializable() {
    return this.entries
      .filter((e) => e.pingMs !== null && e.pingMs !== undefined)
      .map((e) => ({ url: e.url, pingMs: e.pingMs }));
  }

  status() {
    const now = Date.now();
    return this.entries.map((e) => ({
      url: e.url,
      pingMs: e.pingMs,
      available: e.cooldownUntil <= now,
      cooldownRemainingMs: Math.max(0, e.cooldownUntil - now),
      fails: e.fails,
    }));
  }
}

module.exports = { ProxyPool };
