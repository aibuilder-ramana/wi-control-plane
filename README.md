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
- `POST /v1/pairing/session`
- `POST /v1/pairing/claim`
- `GET /v1/pairs/:pairId/status`
- `POST /v1/pairs/:pairId/disconnect`
- WebSocket `/v1/ws/desktop`
- WebSocket `/v1/ws/mobile`

## Railway

This repo includes `railway.json` and is designed to run with:

```sh
node server.js
```

## Domain

Recommended production host:

- `https://connect.getwi.app`
- `wss://connect.getwi.app`
