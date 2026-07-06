# Wi Control Plane / Personal AI Computer Pairing

This module is an isolated MVP for pairing the Wi mobile app with a desktop browser through the Wi Control Plane.

Current MVP scope:
- Create a pairing session from the desktop browser.
- Render a QR payload the mobile app can scan.
- Let the mobile app claim the pairing session once.
- Register desktop and mobile WebSocket connections.
- Bridge presence updates and bidirectional test messages.
- Disconnect or revoke an active pair.

This module intentionally does not:
- run AI inference
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

WebSocket endpoints:
- `GET /v1/ws/desktop?session=<pairingSessionId>&token=<desktopSessionToken>`
- `GET /v1/ws/mobile?pairId=<pairId>&token=<mobileWsToken>`

Bridge events:
- `DESKTOP_READY`
- `PAIR_CONFIRMED`
- `PRESENCE`
- `TEST_MESSAGE`
- `PAIR_DISCONNECTED`
- `ERROR`

## Local Flow

1. Start the Wi server.
2. Open the desktop connect page at `/connect.html` or the deployed `connect.getwi.app` host.
3. The page creates a pairing session and renders the QR payload.
4. In the mobile app, open `Profile` -> `Connect to your Personal AI Computer`.
5. Scan the QR code and claim the session.
6. Keep both clients connected to exchange test messages.
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

To evolve this toward local AI inference later:
- keep pairing and transport concerns in this module
- add authenticated command channels on top of the existing pair bridge
- route any future desktop or on-device AI requests through a separate AI layer rather than mixing them into pairing state

That separation keeps this MVP replaceable without impacting the rest of the app.
