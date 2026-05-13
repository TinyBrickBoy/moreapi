# moreapi

Ein einfacher rotierender Proxy-Server. Du schickst eine Anfrage an
`http://localhost:3000/<host>/<pfad>` und der Server leitet sie über einen
Proxy aus deiner Liste an `https://<host>/<pfad>` weiter. Failt ein Proxy
(Timeout, 429, 5xx, Netzwerkfehler), wandert er für eine konfigurierbare Zeit
auf eine Warteliste und der nächste Proxy wird probiert.

## Quickstart

```bash
cp config.example.json config.json   # Proxies + allowedHosts eintragen
npm install
npm start
```

Anfrage stellen:

```bash
curl http://localhost:3000/api.onthepixel.net/v1/whatever
curl http://localhost:3000/api.mojang.com/users/profiles/minecraft/Notch
```

Status der Proxies anzeigen:

```bash
curl http://localhost:3000/_status
```

## Dateien – was ist was

### `server.js`
Der Express-Server. Macht das Routing und Forwarding.

- Liest `config.json`, baut Host-Configs und Proxy-Pool auf
- `GET /_status` – zeigt Pool-Zustand, Hosts, Quellen
- `ALL /:host/*` – eigentliche Weiterleitung:
  1. prüft ob `host` in `allowedHosts`
  2. checkt Rate-Limit für diesen Host
  3. holt Proxy aus dem Pool
  4. schickt Request mit `node-fetch` + passendem Agent
  5. bei Retry-Status oder Netzwerkfehler → Proxy auf Cooldown, nächster Versuch

### `proxyPool.js`
Verwaltet die Proxy-Liste.

- `setProxies(urls)` – tauscht die Liste aus, behält Cooldown-Status für gleichbleibende Proxies
- `pick()` – Round-Robin, überspringt Proxies im Cooldown
- `cooldown(entry, reason)` – parkt einen Proxy für X Minuten
- `status()` – aktueller Zustand aller Proxies

### `proxyValidator.js`
Validiert pro Proxy abhängig vom Schema:
- **socks5/socks5h** → echter SOCKS5-Greeting-Handshake (`0x05 0x01 0x00`),
  akzeptiert nur Server, die `NO_AUTH` (`0x05 0x00`) zurückgeben. Sortiert
  also Auth-pflichtige Proxies (`no accepted authentication type`) und
  HTTP-Server auf SOCKS-Ports raus.
- **socks4/socks4a** → SOCKS4-CONNECT-Probe.
- **http/https** → reiner TCP-Connect.

Lebende Proxies werden **sofort** per `onResult`-Callback in den Pool
gestreamt — der Server bedient Anfragen schon, während der Sweep läuft.
Defaults: Concurrency 500, Timeout 3 s.

### `proxies.cache.json` (auto-generiert)
Wird nach jeder Validation geschrieben (`{ updatedAt, proxies: [{url, pingMs}] }`).
Beim nächsten Start lädt der Server diesen Cache **sofort** in den Pool und
ist direkt einsatzbereit, während die frische Validation im Hintergrund
läuft. Per `.gitignore` ausgeschlossen.

### `proxySources.js`
Lädt Proxies aus drei Quellen.

- `inline` – direkt aus der Config
- `file` – aus einer lokalen Textdatei (eine Zeile pro Proxy)
- `url` – von einer URL (z. B. die TheSpeedX-Liste)
- `startRefreshing(...)` – URL-Quellen werden alle `refreshMinutes` neu geladen

### `proxyAgent.js`
Erzeugt den passenden HTTP-Agent für die Anfrage.

- `http://` / `https://` → `HttpsProxyAgent`
- `socks://`, `socks4://`, `socks5://` → `SocksProxyAgent`

### `rateLimiter.js`
Sliding-Window-Limiter pro Host.

- `check(key, requests, windowMs)` → `{ ok, retryAfterMs }`

### `config.json` / `config.example.json`
Deine echte Config liegt in `config.json` (per `.gitignore` ignoriert).
`config.example.json` ist die Vorlage zum Reinkopieren.

### `package.json`
Dependencies: `express`, `node-fetch`, `https-proxy-agent`, `socks-proxy-agent`.

## Request-Flow in einem Satz

```
Request → Host-Check → Rate-Limit → N Proxies aus dem Pool ziehen
       → parallel fetchen, schnellste Antwort gewinnt, Rest abbrechen
       → Loser/Fehler kriegen Cooldown → bei Bedarf nächste Runde
```

`concurrency` (global oder per Host) steuert, wie viele Proxies pro Anfrage
gleichzeitig laufen. Default = 3.

## Config-Referenz

```json
{
  "port": 3000,
  "cooldownMinutes": 30,
  "maxRetries": 3,
  "requestTimeoutSeconds": 20,
  "concurrency": 3,
  "retryStatusCodes": [408, 425, 429, 500, 502, 503, 504],
  "validation": {
    "enabled": true,
    "timeoutSeconds": 3,
    "concurrency": 500
  },

  "allowedHosts": [
    {
      "host": "api.onthepixel.net",
      "rateLimit": { "requests": 60, "windowSeconds": 60 },
      "maxRetries": 5,
      "retryStatusCodes": [429, 500, 502, 503, 504],
      "requestTimeoutSeconds": 15
    },
    { "host": "api.mojang.com", "rateLimit": { "requests": 30, "windowSeconds": 60 } },
    "api.example.com"
  ],

  "proxySources": [
    { "type": "inline", "proxies": ["http://user:pass@proxy.example.com:8080"] },
    { "type": "file", "path": "./proxies.txt", "scheme": "http" },
    {
      "type": "url",
      "url": "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/refs/heads/master/socks5.txt",
      "scheme": "socks5",
      "refreshMinutes": 60
    }
  ]
}
```

### Felder

**Global (Defaults für alle Hosts):**
- `port` – auf welchem Port der Server hört
- `hotReload` – wenn `true` (Default), werden Änderungen an `config.json` automatisch übernommen, ohne Restart. Manuell triggerbar via `POST /_reload`.
- `cooldownMinutes` – wie lange ein gefailter Proxy gesperrt wird
- `maxRetries` – wie viele Proxies pro Anfrage probiert werden
- `requestTimeoutSeconds` – Timeout pro Versuch
- `concurrency` – wie viele Proxies pro Anfrage parallel laufen (Race, Schnellste gewinnt)
- `retryStatusCodes` – Status-Codes, die einen Retry auf einem anderen Proxy auslösen
- `validation.enabled` – beim Start (und Refresh) per TCP-Connect prüfen, ob der Proxy-Port überhaupt offen ist
- `validation.timeoutSeconds` – Timeout pro TCP-Connect
- `validation.concurrency` – wie viele Proxies parallel getestet werden

**`allowedHosts`** – Liste der erlaubten Ziel-Hosts. Entweder ein String
(`"api.example.com"`) oder ein Objekt mit:
- `host` – der Hostname
- `rateLimit.requests` + `rateLimit.windowSeconds` – z. B. 60 Requests pro 60 s
- `maxRetries`, `retryStatusCodes`, `requestTimeoutSeconds` – überschreibt die globalen Defaults nur für diesen Host

**`proxySources`** – woher die Proxies kommen.
- `inline` – fester Array in der Config
- `file` – Textdatei, eine Zeile pro Proxy (`host:port` oder `scheme://host:port`)
- `url` – Remote-Liste, gleiches Format; `refreshMinutes` lädt sie periodisch neu
- `scheme` (optional) – wird bei Zeilen ohne `://` davorgesetzt (`http`, `socks5`, …)

## Verhalten bei Fehlern

| Situation | Verhalten |
|---|---|
| Host nicht in `allowedHosts` | `403` |
| Rate-Limit überschritten | `429` + `Retry-After` |
| Proxy liefert 429/5xx oder Netzwerkfehler | Cooldown, nächster Proxy |
| Alle `maxRetries` fehlgeschlagen | `502` |
| Kein Proxy verfügbar (alle im Cooldown) | `503` |
