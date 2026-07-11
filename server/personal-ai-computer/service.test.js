const test = require('node:test')
const assert = require('node:assert/strict')
const { PersonalAiComputerService } = require('./service')

function fakeSocket(label = 'socket', service = null) {
  const socket = {
    label,
    closed: false,
    sent: [],
    meta: {},
    authToken: '',
    lastPongAt: service ? service.now() : Date.now(),
    pings: 0,
    sendJson(payload) { this.sent.push(payload) },
    sendPing() { this.pings += 1 },
    close() {
      if (this.closed) return
      this.closed = true
      if (service) service.handleSocketClose(this)
    },
  }
  return socket
}

function createService(options = {}) {
  let current = Date.parse('2026-07-04T12:00:00Z')
  let nonce = 1
  const service = new PersonalAiComputerService({
    now: () => current,
    randomBytes: size => Buffer.alloc(size, nonce++),
    ...options,
  })
  return {
    service,
    advance(ms) { current += ms },
  }
}

function qrToken(session) {
  return new URL(session.qrPayload).searchParams.get('token')
}

function pairDesktopAndMobile(service) {
  const session = service.createPairingSession()
  const desktop = fakeSocket('desktop', service)
  const mobile = fakeSocket('mobile', service)
  const desktopConnect = service.registerDesktopConnection({
    pairingSessionId: session.pairingSessionId,
    token: session.desktopSessionToken,
    connection: desktop,
  })
  assert.equal(desktopConnect.ok, true)
  const claimed = service.claimPairingSession({
    pairingSessionId: session.pairingSessionId,
    oneTimeToken: qrToken(session),
    mobileDeviceId: 'mobile-1',
    mobileDeviceName: 'Ramana Wi',
  })
  assert.equal(claimed.ok, true)
  const mobileConnect = service.registerMobileConnection({
    pairId: claimed.payload.pairId,
    token: claimed.payload.mobileWsToken,
    connection: mobile,
  })
  assert.equal(mobileConnect.ok, true)
  return { session, desktop, mobile, claimed }
}

test('creating pairing session returns qr payload and expiry', () => {
  const { service } = createService()
  const session = service.createPairingSession()
  assert.match(session.pairingSessionId, /^ps_/)
  assert.match(session.desktopSessionToken, /^dst_/)
  assert.match(session.qrPayload, /^wi:\/\/pair\?session=/)
  assert.ok(session.expiresAt)
})

test('expired session cannot be claimed', () => {
  const { service, advance } = createService()
  const session = service.createPairingSession()
  advance(6 * 60_000)
  const result = service.claimPairingSession({
    pairingSessionId: session.pairingSessionId,
    oneTimeToken: qrToken(session),
    mobileDeviceId: 'mobile-1',
    mobileDeviceName: 'Ramana Wi',
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 410)
  assert.equal(result.error, 'pairing_session_expired')
})

test('claimed session cannot be claimed again', () => {
  const { service } = createService()
  const session = service.createPairingSession()
  const first = service.claimPairingSession({
    pairingSessionId: session.pairingSessionId,
    oneTimeToken: qrToken(session),
    mobileDeviceId: 'mobile-1',
    mobileDeviceName: 'Ramana Wi',
  })
  assert.equal(first.ok, true)
  const second = service.claimPairingSession({
    pairingSessionId: session.pairingSessionId,
    oneTimeToken: qrToken(session),
    mobileDeviceId: 'mobile-2',
    mobileDeviceName: 'Other Wi',
  })
  assert.equal(second.ok, false)
  assert.equal(second.status, 409)
  assert.equal(second.error, 'pairing_session_already_claimed')
})

test('invalid claim token fails', () => {
  const { service } = createService()
  const session = service.createPairingSession()
  const result = service.claimPairingSession({
    pairingSessionId: session.pairingSessionId,
    oneTimeToken: 'wrong-token',
    mobileDeviceId: 'mobile-1',
    mobileDeviceName: 'Ramana Wi',
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 401)
  assert.equal(result.error, 'invalid_one_time_token')
})

test('valid claim creates pair with mobile ws token', () => {
  const { service } = createService()
  const session = service.createPairingSession()
  const result = service.claimPairingSession({
    pairingSessionId: session.pairingSessionId,
    oneTimeToken: qrToken(session),
    mobileDeviceId: 'mobile-1',
    mobileDeviceName: 'Ramana Wi',
  })
  assert.equal(result.ok, true)
  assert.match(result.payload.pairId, /^pair_/)
  assert.match(result.payload.mobileWsToken, /^mws_/)
  assert.equal(result.payload.status, 'paired')
})

test('desktop socket receives pair confirmed event', () => {
  const { service } = createService()
  const session = service.createPairingSession()
  const desktop = fakeSocket('desktop')
  service.registerDesktopConnection({
    pairingSessionId: session.pairingSessionId,
    token: session.desktopSessionToken,
    connection: desktop,
  })
  service.claimPairingSession({
    pairingSessionId: session.pairingSessionId,
    oneTimeToken: qrToken(session),
    mobileDeviceId: 'mobile-1',
    mobileDeviceName: 'Ramana Wi',
  })
  assert.equal(desktop.sent.some(event => event.type === 'PAIR_CONFIRMED' && event.mobileDeviceName === 'Ramana Wi'), true)
})

test('mobile message forwards to desktop', () => {
  const { service } = createService()
  const { desktop, mobile, claimed } = pairDesktopAndMobile(service)
  mobile.meta = { role: 'mobile', pairId: claimed.payload.pairId, pairingSessionId: 'ignored' }
  service.handleSocketMessage(mobile, JSON.stringify({
    type: 'TEST_MESSAGE',
    pairId: claimed.payload.pairId,
    payload: { text: 'Hello from mobile' },
  }))
  assert.equal(desktop.sent.some(event => event.type === 'TEST_MESSAGE' && event.payload?.text === 'Hello from mobile' && event.from === 'mobile'), true)
})

test('desktop message forwards to mobile', () => {
  const { service } = createService()
  const { session, desktop, mobile, claimed } = pairDesktopAndMobile(service)
  desktop.meta = { role: 'desktop', pairId: claimed.payload.pairId, pairingSessionId: session.pairingSessionId }
  service.handleSocketMessage(desktop, JSON.stringify({
    type: 'TEST_MESSAGE',
    pairId: claimed.payload.pairId,
    payload: { text: 'Hello from desktop' },
  }))
  assert.equal(mobile.sent.some(event => event.type === 'TEST_MESSAGE' && event.payload?.text === 'Hello from desktop' && event.from === 'desktop'), true)
})

test('disconnect marks pair inactive', () => {
  const { service } = createService()
  const { session, claimed } = pairDesktopAndMobile(service)
  const result = service.disconnectPair(claimed.payload.pairId, session.desktopSessionToken, 'desktop_disconnect')
  assert.equal(result.ok, true)
  const status = service.getPairStatus(claimed.payload.pairId, session.desktopSessionToken)
  assert.equal(status.ok, true)
  assert.equal(status.payload.desktopOnline, false)
  assert.equal(status.payload.mobileOnline, false)
  assert.equal(status.payload.status, 'disconnected')
})

test('messages cannot be sent across unrelated pairs', () => {
  const { service } = createService()
  const first = pairDesktopAndMobile(service)
  const second = pairDesktopAndMobile(service)
  first.mobile.meta = { role: 'mobile', pairId: first.claimed.payload.pairId, pairingSessionId: first.session.pairingSessionId }
  service.handleSocketMessage(first.mobile, JSON.stringify({
    type: 'TEST_MESSAGE',
    pairId: second.claimed.payload.pairId,
    payload: { text: 'cross-pair' },
  }))
  assert.equal(first.mobile.sent.some(event => event.type === 'ERROR' && event.code === 'PAIR_MISMATCH'), true)
  assert.equal(second.desktop.sent.some(event => event.type === 'TEST_MESSAGE' && event.payload?.text === 'cross-pair'), false)
})

test('heartbeat tick pings live connections', () => {
  const { service } = createService()
  const { desktop, mobile } = pairDesktopAndMobile(service)
  service.runHeartbeatTick()
  assert.equal(desktop.pings, 1)
  assert.equal(mobile.pings, 1)
  assert.equal(desktop.closed, false)
  assert.equal(mobile.closed, false)
})

test('heartbeat tick closes connections that stopped responding', () => {
  const { service, advance } = createService({ staleConnectionMs: 45_000 })
  const { desktop, mobile } = pairDesktopAndMobile(service)
  advance(46_000)
  mobile.lastPongAt = service.now() // mobile stayed alive, desktop went dark
  service.runHeartbeatTick()
  assert.equal(desktop.closed, true)
  assert.equal(mobile.closed, false)
  assert.equal(mobile.pings, 1)
})

test('a pair with both sides offline survives indefinitely (no abandonment sweep)', () => {
  const { service, advance } = createService()
  const { claimed, desktop, mobile } = pairDesktopAndMobile(service)
  desktop.close()
  mobile.close()
  advance(10 * 24 * 60 * 60_000) // 10 days
  service.runHeartbeatTick()
  assert.equal(service.pairs.has(claimed.payload.pairId), true)
})

test('heartbeat tick drops revoked pairs after the retention window', () => {
  const { service, advance } = createService({ pairRetentionMs: 5 * 60_000 })
  const { session, claimed } = pairDesktopAndMobile(service)
  service.disconnectPair(claimed.payload.pairId, session.desktopSessionToken, 'user_disconnected')
  assert.equal(service.pairs.has(claimed.payload.pairId), true)
  advance(6 * 60_000)
  service.runHeartbeatTick()
  assert.equal(service.pairs.has(claimed.payload.pairId), false)
})

test('registerDesktopConnectionByPair reconnects a desktop bridge using pairId + desktopToken', () => {
  const { service } = createService()
  const { session, claimed, desktop: originalDesktop } = pairDesktopAndMobile(service)
  const desktopToken = originalDesktop.sent.find(e => e.type === 'PAIR_CONFIRMED' && e.desktopToken).desktopToken
  assert.match(desktopToken, /^dtk_/)

  const bridge = fakeSocket('bridge', service)
  const result = service.registerDesktopConnectionByPair({
    pairId: claimed.payload.pairId,
    token: desktopToken,
    connection: bridge,
  })
  assert.equal(result.ok, true)
  assert.equal(bridge.sent.some(e => e.type === 'PAIR_CONFIRMED'), true)
  assert.equal(service.pairs.get(claimed.payload.pairId).desktopSocket, bridge)
})

test('registerDesktopConnectionByPair rejects a wrong token', () => {
  const { service } = createService()
  const { claimed } = pairDesktopAndMobile(service)
  const bridge = fakeSocket('bridge', service)
  const result = service.registerDesktopConnectionByPair({
    pairId: claimed.payload.pairId,
    token: 'wrong-token',
    connection: bridge,
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 401)
  assert.equal(result.error, 'invalid_desktop_token')
})

test('registerDesktopConnectionByPair rejects a revoked pair', () => {
  const { service } = createService()
  const { session, claimed, desktop } = pairDesktopAndMobile(service)
  const desktopToken = desktop.sent.find(e => e.type === 'PAIR_CONFIRMED' && e.desktopToken).desktopToken
  service.disconnectPair(claimed.payload.pairId, session.desktopSessionToken, 'user_disconnected')
  const bridge = fakeSocket('bridge', service)
  const result = service.registerDesktopConnectionByPair({
    pairId: claimed.payload.pairId,
    token: desktopToken,
    connection: bridge,
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 410)
  assert.equal(result.error, 'pair_revoked')
})

function pairWithDurableDesktop(service) {
  const { session, claimed, mobile, desktop: originalDesktop } = pairDesktopAndMobile(service)
  const desktopToken = originalDesktop.sent.find(e => e.type === 'PAIR_CONFIRMED' && e.desktopToken).desktopToken
  const bridge = fakeSocket('bridge', service)
  service.registerDesktopConnectionByPair({ pairId: claimed.payload.pairId, token: desktopToken, connection: bridge })
  mobile.meta = { role: 'mobile', pairId: claimed.payload.pairId, pairingSessionId: session.pairingSessionId }
  return { session, claimed, mobile, bridge }
}

test('AI_TEST_REQUEST forwards from mobile to the connected desktop bridge', () => {
  const { service } = createService()
  const { claimed, mobile, bridge } = pairWithDurableDesktop(service)
  service.handleSocketMessage(mobile, JSON.stringify({
    type: 'AI_TEST_REQUEST',
    pairId: claimed.payload.pairId,
    requestId: 'req-1',
    payload: { prompt: 'Say hello' },
  }))
  const forwarded = bridge.sent.find(e => e.type === 'AI_TEST_REQUEST')
  assert.ok(forwarded)
  assert.equal(forwarded.requestId, 'req-1')
  assert.equal(forwarded.payload.prompt, 'Say hello')
})

test('AI_TEST_REQUEST gets DESKTOP_OFFLINE when no desktop bridge is connected', () => {
  const { service } = createService()
  const { claimed, mobile, desktop } = pairDesktopAndMobile(service)
  desktop.close()
  mobile.meta = { role: 'mobile', pairId: claimed.payload.pairId, pairingSessionId: 'ignored' }
  service.handleSocketMessage(mobile, JSON.stringify({
    type: 'AI_TEST_REQUEST',
    pairId: claimed.payload.pairId,
    requestId: 'req-2',
    payload: { prompt: 'Say hello' },
  }))
  const error = mobile.sent.find(e => e.type === 'AI_TEST_ERROR')
  assert.ok(error)
  assert.equal(error.requestId, 'req-2')
  assert.equal(error.payload.code, 'DESKTOP_OFFLINE')
})

test('AI_TEST_RESPONSE forwards from desktop bridge to mobile', () => {
  const { service } = createService()
  const { claimed, mobile, bridge } = pairWithDurableDesktop(service)
  service.handleSocketMessage(bridge, JSON.stringify({
    type: 'AI_TEST_RESPONSE',
    pairId: claimed.payload.pairId,
    requestId: 'req-3',
    payload: { model: 'qwen3:32b', text: 'Hello!' },
  }))
  const forwarded = mobile.sent.find(e => e.type === 'AI_TEST_RESPONSE')
  assert.ok(forwarded)
  assert.equal(forwarded.requestId, 'req-3')
  assert.equal(forwarded.payload.text, 'Hello!')
})

test('AI_TEST_ERROR from desktop bridge forwards to mobile', () => {
  const { service } = createService()
  const { claimed, mobile, bridge } = pairWithDurableDesktop(service)
  service.handleSocketMessage(bridge, JSON.stringify({
    type: 'AI_TEST_ERROR',
    pairId: claimed.payload.pairId,
    requestId: 'req-4',
    payload: { code: 'OLLAMA_UNAVAILABLE', message: 'Could not reach Ollama.' },
  }))
  const forwarded = mobile.sent.find(e => e.type === 'AI_TEST_ERROR')
  assert.ok(forwarded)
  assert.equal(forwarded.payload.code, 'OLLAMA_UNAVAILABLE')
})

test('PING from a connection gets a direct PONG reply', () => {
  const { service } = createService()
  const { bridge } = pairWithDurableDesktop(service)
  service.handleSocketMessage(bridge, JSON.stringify({ type: 'PING' }))
  assert.equal(bridge.sent.some(e => e.type === 'PONG'), true)
})
