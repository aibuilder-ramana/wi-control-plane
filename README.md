# Wi Control Plane

Standalone bridge service for Wi desktop/mobile pairing.

## What it does

- Creates short-lived desktop pairing sessions
- Serves the desktop QR pairing page
- Lets the Wi mobile app claim a pairing session
- Bridges desktop and mobile WebSocket connections
- Forwards presence and test messages
- Supports disconnect and pair revocation

## What it does not do

- AI inference
- LLM routing
- Gmail, Calendar, SMS, or Bits integration
- Wi onboarding

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
- WebSocket `/v1/ws/desktop?session=<pairingSessionId>`
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
Pairs are dropped from memory 5 minutes after being revoked/disconnected, and
also auto-revoked if both sides have been offline for 30 minutes straight
(abandoned pair, e.g. app closed without hitting disconnect) — both are swept
on the same heartbeat tick, so a long-running deployment doesn't leak pairs
indefinitely.

## Railway

This repo includes `railway.json` and is designed to run with:

```sh
node server.js
```

## Domain

Recommended production host:

- `https://connect.getwi.app`
- `wss://connect.getwi.app`
