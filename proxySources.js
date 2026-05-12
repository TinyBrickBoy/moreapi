const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

function normalizeLine(line, defaultScheme) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (trimmed.includes('://')) return trimmed;
  return `${defaultScheme || 'http'}://${trimmed}`;
}

function parseText(text, scheme) {
  return text
    .split(/\r?\n/)
    .map((l) => normalizeLine(l, scheme))
    .filter(Boolean);
}

async function loadOne(source, baseDir) {
  if (source.type === 'inline') {
    return (source.proxies || [])
      .map((p) => normalizeLine(p, source.scheme))
      .filter(Boolean);
  }
  if (source.type === 'file') {
    const filePath = path.isAbsolute(source.path) ? source.path : path.join(baseDir, source.path);
    const text = fs.readFileSync(filePath, 'utf8');
    return parseText(text, source.scheme);
  }
  if (source.type === 'url') {
    const res = await fetch(source.url, { timeout: 15000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return parseText(text, source.scheme);
  }
  throw new Error(`unknown source type: ${source.type}`);
}

async function loadAll(sources, baseDir) {
  const results = await Promise.all(
    sources.map(async (s) => {
      try {
        const list = await loadOne(s, baseDir);
        console.log(`[sources] ${s.type} -> ${list.length} proxies${s.url ? ' (' + s.url + ')' : ''}${s.path ? ' (' + s.path + ')' : ''}`);
        return list;
      } catch (err) {
        console.warn(`[sources] ${s.type} failed: ${err.message}`);
        return [];
      }
    }),
  );
  return [...new Set(results.flat())];
}

function startRefreshing(sources, onTick) {
  const minutes = sources
    .filter((s) => s.type === 'url' && s.refreshMinutes)
    .map((s) => s.refreshMinutes);
  if (!minutes.length) return;
  const intervalMs = Math.min(...minutes) * 60 * 1000;
  setInterval(async () => {
    try {
      await onTick();
    } catch (err) {
      console.warn(`[sources] refresh failed: ${err.message}`);
    }
  }, intervalMs).unref();
}

module.exports = { loadAll, startRefreshing };
