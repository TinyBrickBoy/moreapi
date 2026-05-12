const fs = require('fs');
const path = require('path');
const express = require('express');
const fetch = require('node-fetch');
const { ProxyPool } = require('./proxyPool');
const { loadAll, startRefreshing } = require('./proxySources');
const { agentFor } = require('./proxyAgent');
const { RateLimiter } = require('./rateLimiter');

const configPath = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const baseDir = path.dirname(configPath);

const defaults = {
  maxRetries: config.maxRetries ?? 3,
  retryStatusCodes: config.retryStatusCodes ?? [408, 425, 429, 500, 502, 503, 504],
  cooldownMinutes: config.cooldownMinutes ?? 30,
  requestTimeoutSeconds: config.requestTimeoutSeconds ?? 20,
};

const hostConfigs = new Map();
for (const entry of config.allowedHosts ?? []) {
  if (typeof entry === 'string') {
    hostConfigs.set(entry, { host: entry });
  } else if (entry && entry.host) {
    hostConfigs.set(entry.host, entry);
  }
}

function hostConf(host) {
  const h = hostConfigs.get(host) || {};
  return {
    maxRetries: h.maxRetries ?? defaults.maxRetries,
    retryStatusCodes: new Set(h.retryStatusCodes ?? defaults.retryStatusCodes),
    requestTimeoutMs: (h.requestTimeoutSeconds ?? defaults.requestTimeoutSeconds) * 1000,
    rateLimit: h.rateLimit,
  };
}

const pool = new ProxyPool(defaults.cooldownMinutes * 60 * 1000);
const limiter = new RateLimiter();
const sources = normalizeSources(config);

function normalizeSources(cfg) {
  if (Array.isArray(cfg.proxySources) && cfg.proxySources.length) return cfg.proxySources;
  if (Array.isArray(cfg.proxies) && cfg.proxies.length) {
    return [{ type: 'inline', proxies: cfg.proxies }];
  }
  return [];
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

function cleanRequestHeaders(raw, targetHost) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  out.host = targetHost;
  return out;
}

function copyResponseHeaders(srcHeaders, res) {
  srcHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;
    if (lower === 'content-encoding') return;
    res.setHeader(key, value);
  });
}

const app = express();
app.use(express.raw({ type: '*/*', limit: '50mb' }));

app.get('/_status', (_req, res) => {
  res.json({
    proxies: pool.status(),
    hosts: [...hostConfigs.values()],
    sources: sources.map((s) => ({ type: s.type, url: s.url, path: s.path, scheme: s.scheme })),
  });
});

app.all('/:host/*', async (req, res) => {
  const host = req.params.host;
  if (!hostConfigs.has(host)) {
    return res.status(403).json({ error: `Host '${host}' not in allowedHosts` });
  }

  const hConf = hostConf(host);

  if (hConf.rateLimit) {
    const windowMs = (hConf.rateLimit.windowSeconds ?? 60) * 1000;
    const limit = limiter.check(host, hConf.rateLimit.requests, windowMs);
    if (!limit.ok) {
      res.setHeader('Retry-After', Math.ceil(limit.retryAfterMs / 1000));
      return res.status(429).json({
        error: `Rate limit exceeded for ${host}`,
        retryAfterMs: limit.retryAfterMs,
      });
    }
  }

  const rest = req.originalUrl.substring(host.length + 1) || '/';
  const targetUrl = `https://${host}${rest}`;
  const headers = cleanRequestHeaders(req.headers, host);
  const body = ['GET', 'HEAD'].includes(req.method) || !req.body?.length ? undefined : req.body;

  let lastError = null;

  for (let attempt = 0; attempt < hConf.maxRetries; attempt++) {
    const entry = pool.pick();
    if (!entry) {
      return res.status(503).json({ error: 'No proxies currently available', poolStatus: pool.status() });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), hConf.requestTimeoutMs);

    try {
      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body,
        agent: agentFor(entry.url),
        redirect: 'manual',
        signal: controller.signal,
      });

      if (hConf.retryStatusCodes.has(upstream.status)) {
        pool.cooldown(entry, `upstream status ${upstream.status}`);
        lastError = `upstream returned ${upstream.status}`;
        continue;
      }

      res.status(upstream.status);
      copyResponseHeaders(upstream.headers, res);
      res.setHeader('x-proxy-used', entry.url.replace(/\/\/[^@]+@/, '//***@'));
      const buf = Buffer.from(await upstream.arrayBuffer());
      return res.send(buf);
    } catch (err) {
      pool.cooldown(entry, `network error: ${err.message}`);
      lastError = err.message;
    } finally {
      clearTimeout(timer);
    }
  }

  res.status(502).json({ error: 'All proxy attempts failed', detail: lastError });
});

(async () => {
  const urls = await loadAll(sources, baseDir);
  pool.setProxies(urls);
  startRefreshing(sources, baseDir, (fresh) => {
    pool.setProxies(fresh);
    console.log(`[pool] refreshed, ${fresh.length} proxies total`);
  });

  const port = config.port ?? 3000;
  app.listen(port, () => {
    console.log(`proxy listening on http://localhost:${port}`);
    console.log(`allowed hosts: ${[...hostConfigs.keys()].join(', ') || '(none)'}`);
    console.log(`proxies loaded: ${pool.entries.length}`);
  });
})();
