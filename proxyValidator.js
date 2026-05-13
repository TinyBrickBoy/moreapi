const net = require('net');

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

async function checkOne(proxyUrl, timeoutMs) {
  let u;
  try {
    u = new URL(proxyUrl);
  } catch {
    return null;
  }
  const port = parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80);
  return tcpPing(u.hostname, port, timeoutMs);
}

async function validateAll(urls, { timeoutMs, concurrency }, onResult) {
  if (!urls.length) return [];
  const queue = urls.slice();
  const working = [];
  let done = 0;
  const total = urls.length;
  const logEvery = Math.max(100, Math.floor(total / 20));

  const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (queue.length) {
      const url = queue.shift();
      const pingMs = await checkOne(url, timeoutMs);
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
