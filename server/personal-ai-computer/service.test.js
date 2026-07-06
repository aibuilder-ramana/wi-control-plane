const test = require('node:test')
const assert = require('node:assert/strict')
const { PersonalAiComputerService } = require('./service')

function fakeSocket(label = 'socket') {
  return {
    label,
    closed: false,
    sent: [],
    meta: {},
    authToken: '',
    sendJson(payload) { this.sent.push(payload) },
    close() { this.closed = true },
  }
}

function createService() {
  let current = Date.parse('2026-07-04T12:00:00Z')
  let nonce = 1
  const service = new PersonalAiComputerService({
    now: () => current,
    randomBytes: size => Buffer.alloc(size, nonce++),
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
  const desktop = fakeSocket('desktop')
  const mobile = fakeSocket('mobile')
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
