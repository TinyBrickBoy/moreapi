const fetch = require('node-fetch');
const { agentFor } = require('./proxyAgent');

async function checkOne(proxyUrl, testUrl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(testUrl, {
      method: 'GET',
      agent: agentFor(proxyUrl),
      signal: controller.signal,
      redirect: 'manual',
    });
    if (res.status >= 500) return null;
    return Date.now() - t0;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function validateAll(urls, { testUrl, timeoutMs, concurrency }, onResult) {
  if (!urls.length) return [];
  const queue = urls.slice();
  const working = [];
  let done = 0;
  const total = urls.length;
  const logEvery = Math.max(50, Math.floor(total / 20));

  const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (queue.length) {
      const url = queue.shift();
      const pingMs = await checkOne(url, testUrl, timeoutMs);
      if (pingMs !== null) {
        const entry = { url, pingMs };
        working.push(entry);
        if (onResult) {
          try { onResult(entry); } catch (_) {}
        }
      }
      done++;
      if (done % logEvery === 0 || done === total) {
        console.log(`[validate] ${done}/${total} checked, ${working.length} working`);
      }
    }
  });

  await Promise.all(workers);
  working.sort((a, b) => a.pingMs - b.pingMs);
  return working;
}

module.exports = { validateAll };
