const fetch = require('node-fetch');
const { agentFor } = require('./proxyAgent');

async function checkOne(proxyUrl, testUrl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(testUrl, {
      method: 'GET',
      agent: agentFor(proxyUrl),
      signal: controller.signal,
      redirect: 'manual',
    });
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function validateAll(urls, { testUrl, timeoutMs, concurrency }) {
  if (!urls.length) return [];
  const queue = urls.slice();
  const working = [];
  let done = 0;
  const total = urls.length;
  const logEvery = Math.max(50, Math.floor(total / 20));

  const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (queue.length) {
      const url = queue.shift();
      const ok = await checkOne(url, testUrl, timeoutMs);
      if (ok) working.push(url);
      done++;
      if (done % logEvery === 0 || done === total) {
        console.log(`[validate] ${done}/${total} checked, ${working.length} working`);
      }
    }
  });

  await Promise.all(workers);
  return working;
}

module.exports = { validateAll };
