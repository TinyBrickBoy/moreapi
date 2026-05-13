const net = require('net');
const fetch = require('node-fetch');
const { agentFor } = require('./proxyAgent');

function tcpPing(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const t0 = Date.now();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once('connect', () => finish(Date.now() - t0));
    socket.once('error', () => finish(null));
    try {
      socket.connect(port, host);
    } catch {
      finish(null);
    }
  });
}

async function httpProbe(proxyUrl, checkUrl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const agent = agentFor(proxyUrl);
  const t0 = Date.now();
  try {
    const res = await fetch(checkUrl, {
      agent,
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'user-agent': 'proxy-validator/1.0', accept: '*/*' },
    });
    try { res.body?.resume?.(); res.body?.destroy?.(); } catch (_) {}
    if (res.status >= 500) return null;
    return Date.now() - t0;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    try { agent.destroy?.(); } catch (_) {}
  }
}

async function checkOne(proxyUrl, opts) {
  let u;
  try {
    u = new URL(proxyUrl);
  } catch {
    return null;
  }
  const port = parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80);
  const tcpMs = await tcpPing(u.hostname, port, opts.tcpTimeoutMs);
  if (tcpMs === null) return null;
  if (opts.mode === 'tcp') return tcpMs;
  return httpProbe(proxyUrl, opts.checkUrl, opts.httpTimeoutMs);
}

async function validateAll(urls, opts, onResult) {
  if (!urls.length) return [];
  const queue = urls.slice();
  const working = [];
  let done = 0;
  const total = urls.length;
  const logEvery = Math.max(100, Math.floor(total / 20));

  const workers = Array.from({ length: Math.min(opts.concurrency, total) }, async () => {
    while (queue.length) {
      const url = queue.shift();
      const pingMs = await checkOne(url, opts);
      if (pingMs !== null) {
        const entry = { url, pingMs };
        working.push(entry);
        if (onResult) {
          try { onResult(entry); } catch (_) {}
        }
      }
      done++;
      if (done % logEvery === 0 || done === total) {
        console.log(`[validate] ${done}/${total} checked, ${working.length} alive`);
      }
    }
  });

  await Promise.all(workers);
  working.sort((a, b) => a.pingMs - b.pingMs);
  return working;
}

module.exports = { validateAll };
