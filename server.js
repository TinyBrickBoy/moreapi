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
const baseDir = path.dirname(configPath);

function readConfigFile() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

let config = readConfigFile();
const cacheFile = config.cacheFile
  ? path.isAbsolute(config.cacheFile) ? config.cacheFile : path.join(baseDir, config.cacheFile)
  : path.join(baseDir, 'proxies.cache.json');

let defaults, validation, hostConfigs, sources;
let refreshTimerStop = null;

function normalizeSources(cfg) {
  if (Array.isArray(cfg.proxySources) && cfg.proxySources.length) return cfg.proxySources;
  if (Array.isArray(cfg.proxies) && cfg.proxies.length) {
    return [{ type: 'inline', proxies: cfg.proxies }];
  }
  return [];
}

function buildHostConfigs(cfg) {
  const m = new Map();
  for (const entry of cfg.allowedHosts ?? []) {
    if (typeof entry === 'string') m.set(entry, { host: entry });
    else if (entry && entry.host) m.set(entry.host, entry);
  }
  return m;
}

function applyConfig(cfg) {
  defaults = {
    maxRetries: cfg.maxRetries ?? 3,
    retryStatusCodes: cfg.retryStatusCodes ?? [408, 425, 429, 500, 502, 503, 504],
    cooldownMinutes: cfg.cooldownMinutes ?? 30,
    requestTimeoutSeconds: cfg.requestTimeoutSeconds ?? 20,
    concurrency: cfg.concurrency ?? 3,
  };
  validation = {
    enabled: cfg.validation?.enabled ?? true,
    mode: cfg.validation?.mode ?? 'http',
    tcpTimeoutMs: (cfg.validation?.tcpTimeoutSeconds ?? cfg.validation?.timeoutSeconds ?? 3) * 1000,
    httpTimeoutMs: (cfg.validation?.httpTimeoutSeconds ?? 6) * 1000,
    checkUrl: cfg.validation?.checkUrl ?? 'https://www.gstatic.com/generate_204',
    concurrency: cfg.validation?.concurrency ?? 200,
  };
  hostConfigs = buildHostConfigs(cfg);
  sources = normalizeSources(cfg);
  if (pool) pool.setCooldownMs(defaults.cooldownMinutes * 60 * 1000);
}

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

const pool = new ProxyPool(30 * 60 * 1000);
const limiter = new RateLimiter();
applyConfig(config);

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
    const startedAt = entries.map(() => Date.now());
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
          const pingMs = Date.now() - startedAt[i];
          controllers.forEach((c, j) => { if (j !== i) c.abort(); });
          resolve({ entry, response, pingMs });
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

let cacheDirty = false;
let cacheTimer = null;
function scheduleCacheWrite() {
  cacheDirty = true;
  if (cacheTimer) return;
  cacheTimer = setTimeout(() => {
    cacheTimer = null;
    if (!cacheDirty) return;
    cacheDirty = false;
    pool.resort();
    saveCache(pool.serializable());
  }, 5000);
  cacheTimer.unref();
}

const app = express();
app.use(express.raw({ type: '*/*', limit: '50mb' }));

app.get('/_status', (_req, res) => {
  res.json({
    proxies: pool.status(),
    hosts: [...hostConfigs.values()],
    sources: sources.map((s) => ({ type: s.type, url: s.url, path: s.path, scheme: s.scheme })),
    configPath,
    hotReload: config.hotReload !== false,
  });
});

app.post('/_reload', (_req, res) => {
  try {
    reloadConfig({ force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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
      const { entry, response, pingMs } = await raceProxies(entries, hConf, targetUrl, req.method, headers, body);
      pool.recordSuccess(entry, pingMs);
      scheduleCacheWrite();
      res.status(response.status);
      copyResponseHeaders(response.headers, res);
      res.setHeader('x-proxy-used', maskProxy(entry.url));
      res.setHeader('x-proxy-ping', String(pingMs));
      const buf = Buffer.from(await response.arrayBuffer());
      return res.send(buf);
    } catch (err) {
      lastError = err.message;
    }
  }

  res.status(502).json({ error: 'All proxy attempts failed', detail: lastError });
});

async function refreshPool() {
  const urls = await loadAll(sources, baseDir);
  if (!urls.length) {
    console.warn('[pool] no proxies in sources');
    return;
  }
  if (!validation.enabled) {
    pool.setProxies(urls);
    saveCache(pool.serializable());
    return;
  }

  console.log(`[validate] ${validation.mode}-checking ${urls.length} proxies (tcp ${validation.tcpTimeoutMs}ms${validation.mode === 'http' ? `, http ${validation.httpTimeoutMs}ms via ${validation.checkUrl}` : ''}, concurrency ${validation.concurrency}); pool fills as proxies pass`);
  const t0 = Date.now();
  let added = 0;

  const fresh = await validateAll(urls, validation, (entry) => {
    pool.upsert(entry);
    added++;
    if (added === 1 || added % 25 === 0) {
      console.log(`[pool] +${added} proxies live (latest ${entry.url} @ ${entry.pingMs}ms)`);
    }
    scheduleCacheWrite();
  });

  pool.setProxies(fresh);
  saveCache(pool.serializable());
  console.log(`[validate] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${fresh.length}/${urls.length} working${fresh.length ? `, fastest ${fresh[0].pingMs}ms` : ''}`);
}

function reloadConfig({ force = false } = {}) {
  let next;
  try {
    next = readConfigFile();
  } catch (err) {
    console.warn(`[config] reload failed: ${err.message}`);
    return;
  }

  const oldSources = JSON.stringify(sources);
  const oldHosts = JSON.stringify([...hostConfigs.entries()]);
  config = next;
  applyConfig(next);
  console.log('[config] reloaded');

  const newHosts = JSON.stringify([...hostConfigs.entries()]);
  if (oldHosts !== newHosts) {
    console.log(`[config] allowedHosts: ${[...hostConfigs.keys()].join(', ') || '(none)'}`);
  }

  const newSources = JSON.stringify(sources);
  if (force || oldSources !== newSources) {
    if (refreshTimerStop) refreshTimerStop();
    refreshTimerStop = startRefreshing(sources, refreshPool);
    refreshPool().catch((err) => console.warn(`[pool] refresh after reload failed: ${err.message}`));
  }
}

function watchConfig() {
  if (config.hotReload === false) {
    console.log('[config] hot-reload disabled');
    return;
  }
  fs.watchFile(configPath, { interval: 1000 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) reloadConfig();
  });
  console.log(`[config] watching ${configPath} for changes`);
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
  refreshTimerStop = startRefreshing(sources, refreshPool);
  watchConfig();
})();
