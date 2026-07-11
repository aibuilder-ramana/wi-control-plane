# Wi Control Plane / Personal AI Computer Pairing

This module pairs the Wi mobile app with a desktop endpoint through the Wi Control Plane — either the `connect.html` browser page (test messages) or a headless desktop client such as `wi-desktop-bridge` (real AI test requests answered by a local model).

Current scope:
- Create a pairing session from the desktop browser and render a QR payload the mobile app can scan.
- Let the mobile app claim the pairing session once, minting a durable, pair-scoped `mobileWsToken` (mobile) and `desktopToken` (desktop).
- Register desktop and mobile WebSocket connections — either via the original QR-pairing session, or, for the desktop side, directly via the durable `pairId` + `desktopToken` (no re-pairing needed after a client restart).
- Bridge presence updates, bidirectional test messages, and `AI_TEST_REQUEST`/`AI_TEST_RESPONSE`/`AI_TEST_ERROR` between mobile and desktop.
- Disconnect or revoke an active pair.

This module intentionally does not:
- run AI inference itself (a paired desktop client does that)
- install or manage local models
- modify onboarding
- integrate with Bits, Gmail, Calendar, SMS, or any existing intelligence pipeline

## Architecture

The feature is isolated under `server/personal-ai-computer/` for the control-plane service, `public/connect.html` for the desktop connect page, and `android/app/src/main/java/com/finitepaths/wiassistant/ui/personalcomputer/` for the mobile client.

Server responsibilities in this module:
- `service.js`: in-memory pairing session and pair lifecycle management
- `routes.js`: HTTP endpoints for create, claim, status, and disconnect
- `ws.js`: minimal WebSocket upgrade handling for desktop and mobile bridge sockets
- `service.test.js`: unit coverage for the pairing lifecycle and message bridge

## API Surface

HTTP endpoints:
- `POST /v1/pairing/session`
- `POST /v1/pairing/claim`
- `GET /v1/pairs/:pairId/status`
- `POST /v1/pairs/:pairId/disconnect`

WebSocket endpoints (`GET /v1/ws/desktop` and `GET /v1/ws/mobile`) authenticate via a first-message `{type:'AUTH', token}` frame, never a query-string token (proxies/access logs commonly record full upgrade URLs):
- `GET /v1/ws/desktop?session=<pairingSessionId>` — original QR-pairing flow (`connect.html`). AUTH token is the session's `desktopSessionToken`.
- `GET /v1/ws/desktop?pairId=<pairId>` — durable reconnect for a headless desktop client (e.g. `wi-desktop-bridge`). AUTH token is the pair's `desktopToken`, handed out once (see below). Preferred over the session path whenever `pairId` is present.
- `GET /v1/ws/mobile?pairId=<pairId>` — AUTH token is the pair's `mobileWsToken`.

Bridge events (server → client):
- `DESKTOP_READY`, `PAIR_CONFIRMED` (includes `desktopToken` exactly once, only on the initial claim — see below), `PRESENCE`, `TEST_MESSAGE`, `PAIR_DISCONNECTED`, `ERROR`
- `AI_TEST_REQUEST` (mobile → desktop), `AI_TEST_RESPONSE` / `AI_TEST_ERROR` (desktop → mobile)
- `PONG` (reply to a client's app-level `PING`)

Client → server message types handled: `TEST_MESSAGE`, `DISCONNECT`, `AI_TEST_REQUEST`, `AI_TEST_RESPONSE`, `AI_TEST_ERROR`, `PING`, `BRIDGE_READY`, `BRIDGE_HEALTH`. Anything else gets `UNSUPPORTED_MESSAGE_TYPE`.

## Durable desktop auth (for headless clients like wi-desktop-bridge)

`mobileWsToken` (mobile) and `desktopToken` (desktop) are both minted once, at claim time, and are scoped to the **pair**, not the pairing session — they keep working indefinitely across a client's own process restarts, with no re-scan needed. Only the SHA-256 hash is ever retained server-side; the raw value is shown exactly once:

1. Pair via `connect.html`'s QR flow as usual.
2. When the mobile app claims the session, the desktop browser's `PAIR_CONFIRMED` event includes a `desktopToken` field. `connect.html` displays it once (with `pairId`) for copying into a headless client's config — it is **not** redisplayed on any later reconnect.
3. A headless client (e.g. `wi-desktop-bridge`) connects to `/v1/ws/desktop?pairId=<pairId>&client=<name>`, sends `{type:'AUTH', pairId, token: desktopToken}` as its first frame, and can reconnect this way indefinitely — including across its own crashes/restarts — as long as the pair hasn't been explicitly disconnected.

**Known limitation:** `connect.html` (session-token auth) and a durable-token client can both claim `pair.desktopSocket` independently, with no awareness of each other. If both connect to the same pair at once, whichever registers last wins the slot; the other is left connected but orphaned (never explicitly closed). Not solved in this MVP.

**No persistence layer:** `sessions`/`pairs` are in-memory `Map`s only — a Railway restart/redeploy wipes every pair and every token, regardless of how long-lived they're designed to be. Durability here means "survives the *client's* restarts," not "survives the control-plane's."

## Local Flow

1. Start the Wi server.
2. Open the desktop connect page at `/connect.html` or the deployed `connect.getwi.app` host.
3. The page creates a pairing session and renders the QR payload.
4. In the mobile app, open `Profile` -> `Connect to your Personal AI Computer`.
5. Scan the QR code and claim the session.
6. Keep both clients connected to exchange test messages, or copy the shown `pairId`/`desktopToken` into a headless client to exchange `AI_TEST_REQUEST`/`AI_TEST_RESPONSE` instead.
7. Use disconnect on either side to revoke the pair.

## Running Tests

Server tests:

```sh
npm test
```

Android compile verification:

```sh
cd android
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ./gradlew :app:compileDebugKotlin
```

## Extending the Module

`AI_TEST_REQUEST`/`AI_TEST_RESPONSE`/`AI_TEST_ERROR` are a thin, stateless forward — this module still does no AI inference itself and knows nothing about prompts beyond a byte-size cap. Any future integration into Wi's real LLM gateway (e.g. wiring `DesktopLLMProvider` into `LLMGateway.generate()` for real bit/observation enrichment, not just the manual "Ask my Personal AI Computer" test) should keep living in a separate AI layer that calls through this bridge, rather than teaching this module about task types or prompt formats.
