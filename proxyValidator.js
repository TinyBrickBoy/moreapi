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
    try { socket.connect(port, host); } catch { finish(null); }
  });
}

function socks5Handshake(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const t0 = Date.now();
    let done = false;
    let buf = Buffer.alloc(0);
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once('connect', () => {
      // greeting: VER=5, NMETHODS=1, METHODS=[NO_AUTH]
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 2) return;
      // VER=5, METHOD=0x00 means no-auth accepted
      if (buf[0] === 0x05 && buf[1] === 0x00) finish(Date.now() - t0);
      else finish(null);
    });
    socket.once('error', () => finish(null));
    try { socket.connect(port, host); } catch { finish(null); }
  });
}

function socks4Handshake(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const t0 = Date.now();
    let done = false;
    let buf = Buffer.alloc(0);
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once('connect', () => {
      // SOCKS4 CONNECT to 1.1.1.1:80, userid empty
      const req = Buffer.from([0x04, 0x01, 0x00, 0x50, 1, 1, 1, 1, 0x00]);
      socket.write(req);
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 2) return;
      if (buf[0] === 0x00 && buf[1] === 0x5a) finish(Date.now() - t0);
      else finish(null);
    });
    socket.once('error', () => finish(null));
    try { socket.connect(port, host); } catch { finish(null); }
  });
}

async function checkOne(proxyUrl, timeoutMs) {
  let u;
  try { u = new URL(proxyUrl); } catch { return null; }
  const proto = u.protocol.replace(':', '').toLowerCase();
  const port = parseInt(u.port, 10) || (proto === 'https' ? 443 : 80);
  if (proto === 'socks5' || proto === 'socks5h' || proto === 'socks') {
    return socks5Handshake(u.hostname, port, timeoutMs);
  }
  if (proto === 'socks4' || proto === 'socks4a') {
    return socks4Handshake(u.hostname, port, timeoutMs);
  }
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
