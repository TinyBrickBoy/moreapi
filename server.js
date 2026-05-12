const fs = require('fs');
const path = require('path');
const express = require('express');
const fetch = require('node-fetch');
const { ProxyPool } = require('./proxyPool');
const { loadAll, startRefreshing } = require('./proxySources');
const { agentFor } = require('./proxyAgent');
const { RateLimiter } = require('./rateLimiter');
const { validateAll } = require('./proxyValidator');

const configPath = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const baseDir = path.dirname(configPath);
const cacheFile = config.cacheFile
  ? path.isAbsolute(config.cacheFile) ? config.cacheFile : path.join(baseDir, config.cacheFile)
  : path.join(baseDir, 'proxies.cache.json');

function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return Array.isArray(raw.proxies) ? raw.proxies : [];
  } catch {
    return [];
  }
}

function saveCache(entries) {
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ updatedAt: Date.now(), proxies: entries }, null, 2));
  } catch (err) {
    console.warn(`[cache] write failed: ${err.message}`);
  }
}

const defaults = {
  maxRetries: config.maxRetries ?? 3,
  retryStatusCodes: config.retryStatusCodes ?? [408, 425, 429, 500, 502, 503, 504],
  cooldownMinutes: config.cooldownMinutes ?? 30,
  requestTimeoutSeconds: config.requestTimeoutSeconds ?? 20,
  concurrency: config.concurrency ?? 3,
};

const validation = {
  enabled: config.validation?.enabled ?? true,
  testUrl: config.validation?.testUrl ?? 'https://www.google.com/generate_204',
  timeoutMs: (config.validation?.timeoutSeconds ?? 8) * 1000,
  concurrency: config.validation?.concurrency ?? 50,
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
    concurrency: h.concurrency ?? defaults.concurrency,
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
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
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

function maskProxy(url) {
  return url.replace(/\/\/[^@]+@/, '//***@');
}

function raceProxies(entries, hConf, targetUrl, method, headers, body) {
  return new Promise((resolve, reject) => {
    const controllers = entries.map(() => new AbortController());
    const timers = entries.map((_, i) =>
      setTimeout(() => controllers[i].abort(), hConf.requestTimeoutMs),
    );
    const errors = [];
    let resolved = false;
    let pending = entries.length;

    function settle() {
      if (--pending === 0 && !resolved) {
        reject(new Error(errors.join('; ') || 'no proxies'));
      }
    }

    entries.forEach((entry, i) => {
      fetch(targetUrl, {
        method, headers, body,
        agent: agentFor(entry.url),
        redirect: 'manual',
        signal: controllers[i].signal,
      })
        .then((response) => {
          clearTimeout(timers[i]);
          if (resolved) {
            try { response.body?.destroy?.(); } catch (_) {}
            return;
          }
          if (hConf.retryStatusCodes.has(response.status)) {
            pool.cooldown(entry, `upstream status ${response.status}`);
            errors.push(`${entry.url}: ${response.status}`);
            try { response.body?.destroy?.(); } catch (_) {}
            settle();
            return;
          }
          resolved = true;
          controllers.forEach((c, j) => { if (j !== i) c.abort(); });
          resolve({ entry, response });
        })
        .catch((err) => {
          clearTimeout(timers[i]);
          if (resolved) return;
          if (err.name !== 'AbortError') {
            pool.cooldown(entry, `network error: ${err.message}`);
            errors.push(`${entry.url}: ${err.message}`);
          }
          settle();
        });
    });
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

  for (let round = 0; round < hConf.maxRetries; round++) {
    const entries = [];
    const seen = new Set();
    for (let i = 0; i < hConf.concurrency; i++) {
      const e = pool.pick();
      if (!e || seen.has(e.url)) break;
      seen.add(e.url);
      entries.push(e);
    }
    if (!entries.length) {
      return res.status(503).json({ error: 'No proxies currently available', poolStatus: pool.status() });
    }

    try {
      const { entry, response } = await raceProxies(entries, hConf, targetUrl, req.method, headers, body);
      res.status(response.status);
      copyResponseHeaders(response.headers, res);
      res.setHeader('x-proxy-used', maskProxy(entry.url));
      const buf = Buffer.from(await response.arrayBuffer());
      return res.send(buf);
    } catch (err) {
      lastError = err.message;
    }
  }

  res.status(502).json({ error: 'All proxy attempts failed', detail: lastError });
});

async function loadAndValidate() {
  const urls = await loadAll(sources, baseDir);
  if (!validation.enabled || urls.length === 0) return urls;
  console.log(`[validate] testing ${urls.length} proxies against ${validation.testUrl} (timeout ${validation.timeoutMs}ms, concurrency ${validation.concurrency})`);
  const t0 = Date.now();
  const working = await validateAll(urls, validation);
  console.log(`[validate] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${working.length}/${urls.length} working`);
  return working;
}

async function refreshPool() {
  const fresh = await loadAndValidate();
  if (fresh.length) {
    pool.setProxies(fresh);
    saveCache(pool.serializable());
    console.log(`[pool] ready: ${fresh.length} proxies (fastest ${fresh[0].pingMs}ms)`);
  } else {
    console.warn(`[pool] no working proxies found`);
  }
}

(async () => {
  const cached = loadCache();
  if (cached.length) {
    pool.setProxies(cached);
    console.log(`[cache] preloaded ${cached.length} proxies (fastest ${cached[0].pingMs}ms)`);
  }

  const port = config.port ?? 3000;
  app.listen(port, () => {
    console.log(`proxy listening on http://localhost:${port}`);
    console.log(`allowed hosts: ${[...hostConfigs.keys()].join(', ') || '(none)'}`);
    console.log(`proxies loaded: ${pool.entries.length}`);
  });

  refreshPool().catch((err) => console.warn(`[pool] initial refresh failed: ${err.message}`));
  startRefreshing(sources, refreshPool);
})();
