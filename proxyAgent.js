const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

function agentFor(proxyUrl) {
  const scheme = new URL(proxyUrl).protocol.replace(':', '').toLowerCase();
  if (scheme === 'socks' || scheme === 'socks4' || scheme === 'socks4a' || scheme === 'socks5' || scheme === 'socks5h') {
    return new SocksProxyAgent(proxyUrl, { timeout: 15000 });
  }
  return new HttpsProxyAgent(proxyUrl, { timeout: 15000 });
}

module.exports = { agentFor };
