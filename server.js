const fs = require('fs');
const path = require('path');
const express = require('express');
const { ProxyAgent, fetch } = require('undici');
const { ProxyPool } = require('./proxyPool');

const configPath = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const cooldownMs = (config.cooldownMinutes ?? 30) * 60 * 1000;
const retryStatusCodes = new Set(config.retryStatusCodes ?? [408, 425, 429, 500, 502, 503, 504]);
const allowedHosts = new Set(config.allowedHosts ?? []);
const pool = new ProxyPool(config.proxies ?? [], cooldownMs);

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
    if (HOP_BY_HOP.has(key.toLowerCase())) return;
    if (key.toLowerCase() === 'content-encoding') return;
    res.setHeader(key, value);
  });
}

const app = express();
app.use(express.raw({ type: '*/*', limit: '50mb' }));

app.get('/_status', (_req, res) => {
  res.json({ proxies: pool.status(), allowedHosts: [...allowedHosts] });
});

app.all('/:host/*', async (req, res) => {
  const host = req.params.host;
  if (!allowedHosts.has(host)) {
    return res.status(403).json({ error: `Host '${host}' not in allowedHosts` });
  }

  const rest = req.originalUrl.substring(host.length + 1) || '/';
  const targetUrl = `https://${host}${rest}`;
  const headers = cleanRequestHeaders(req.headers, host);
  const body = ['GET', 'HEAD'].includes(req.method) || !req.body?.length ? undefined : req.body;

  const maxRetries = Math.max(1, config.maxRetries ?? 3);
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const entry = pool.pick();
    if (!entry) {
      return res.status(503).json({ error: 'No proxies currently available', poolStatus: pool.status() });
    }

    let dispatcher;
    try {
      dispatcher = new ProxyAgent(entry.url);
    } catch (err) {
      pool.cooldown(entry, `bad proxy url: ${err.message}`);
      lastError = err.message;
      continue;
    }

    try {
      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body,
        dispatcher,
      });

      if (retryStatusCodes.has(upstream.status)) {
        pool.cooldown(entry, `upstream status ${upstream.status}`);
        lastError = `upstream returned ${upstream.status}`;
        try { await upstream.body?.cancel(); } catch (_) {}
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
      try { dispatcher?.close(); } catch (_) {}
    }
  }

  res.status(502).json({ error: 'All proxy attempts failed', detail: lastError });
});

const port = config.port ?? 3000;
app.listen(port, () => {
  console.log(`proxy listening on http://localhost:${port}`);
  console.log(`allowed hosts: ${[...allowedHosts].join(', ') || '(none)'}`);
  console.log(`proxies loaded: ${pool.entries.length}`);
});
