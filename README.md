# Wi Control Plane

Standalone bridge service for Wi desktop/mobile pairing.

## What it does

- Creates short-lived desktop pairing sessions
- Serves the desktop QR pairing page
- Lets the Wi mobile app claim a pairing session, minting durable pair-scoped tokens for both sides
- Bridges desktop and mobile WebSocket connections — including a durable `pairId`+`desktopToken` reconnect path for headless desktop clients (e.g. `wi-desktop-bridge`) that doesn't require re-pairing after a restart
- Forwards presence, test messages, and `AI_TEST_REQUEST`/`AI_TEST_RESPONSE`/`AI_TEST_ERROR` between mobile and a paired desktop
- Supports disconnect and pair revocation

## What it does not do

- Run AI inference itself — it only forwards `AI_TEST_*` messages between mobile and whatever desktop client is paired
- Gmail, Calendar, SMS, or Bits integration
- Wi onboarding
- Persist any state — see "Memory bounds" below

## Run locally

```sh
npm test
npm start
```

The service defaults to `http://localhost:3001`.

Important routes:

- `/connect.html`
- `POST /v1/pairing/session` (rate-limited per IP — `WI_PAIRING_SESSION_RATE_LIMIT_PER_MINUTE`, default 20/min)
- `POST /v1/pairing/claim`
- `GET /v1/pairs/:pairId/status`
- `POST /v1/pairs/:pairId/disconnect`
- WebSocket `/v1/ws/desktop?session=<pairingSessionId>` (original QR-pairing flow) or `/v1/ws/desktop?pairId=<pairId>` (durable reconnect via `desktopToken`, for headless clients — see `server/personal-ai-computer/README.md`)
- WebSocket `/v1/ws/mobile?pairId=<pairId>`

### WebSocket auth handshake

Tokens are never sent in the WS query string (proxies and access logs commonly
record full upgrade URLs). After the `101` upgrade, the client's first text
frame must be:

```json
{ "type": "AUTH", "token": "<desktopSessionToken|mobileWsToken>" }
```

Anything else as the first message, or no message within 5s, closes the
connection with code `1008` and an `ERROR` event (`AUTH_REQUIRED` /
`AUTH_TIMEOUT`).

### Liveness

The server pings every open desktop/mobile socket every ~20s and closes any
connection that hasn't produced a pong (or any frame) in ~45s — this catches
network drops that never send a clean TCP close (e.g. a phone losing signal).
Standard WebSocket clients (browsers, OkHttp) answer ping frames automatically
with no application code required.

### Memory bounds

Expired, unclaimed pairing sessions are swept on each new session creation.
Pairs are dropped from memory 5 minutes after being explicitly
revoked/disconnected. Pairs are otherwise **not** time-based-swept — a
durable desktop client (headless bridge) may legitimately be offline for
hours or days between uses, so there's no "abandoned pair" heuristic to
silently revoke it in the meantime. `sessions`/`pairs` map sizes are logged
each heartbeat tick so growth stays observable. None of this state survives
a process restart/redeploy regardless (in-memory only, no database).

## Railway

This repo includes `railway.json` and is designed to run with:

```sh
node server.js
```

## Domain

Recommended production host:

- `https://connect.getwi.app`
- `wss://connect.getwi.app`
