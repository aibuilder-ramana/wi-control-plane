const crypto = require('crypto')
const { loadPairsFromDisk, savePairsToDisk } = require('./store')

// Matches wi-desktop-bridge's own AI_TEST_REQUEST_MAX_BYTES so an oversized
// prompt is rejected here (cheaply, before waking the desktop) rather than
// only by the bridge after a round trip.
const AI_TEST_REQUEST_MAX_BYTES = 64 * 1024

function nowIso(nowFn) {
  return new Date(nowFn()).toISOString()
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8')
  const right = Buffer.from(String(b || ''), 'utf8')
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

class PersonalAiComputerService {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now())
    this.randomBytes = options.randomBytes || crypto.randomBytes
    this.pairingTtlMs = options.pairingTtlMs || 5 * 60_000
    // How often the heartbeat tick pings live sockets and sweeps stale state.
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 20_000
    // A connection that hasn't produced a pong (or any frame) in this long is
    // treated as dead — covers network drops that never send a clean TCP FIN.
    this.staleConnectionMs = options.staleConnectionMs || 45_000
    // Revoked pairs are kept briefly so a final status check still resolves,
    // then dropped so `pairs` doesn't grow without bound.
    this.pairRetentionMs = options.pairRetentionMs || 5 * 60_000
    // When set, pairs survive a process restart (redeploy, crash) instead of
    // vanishing with the in-memory Map — see store.js for what's persisted.
    this.persistencePath = options.persistencePath || null
    this.sessions = new Map()
    this.pairs = new Map()
    this.heartbeatTimer = null
    if (this.persistencePath) this.loadPersistedPairs()
  }

  loadPersistedPairs() {
    for (const record of loadPairsFromDisk(this.persistencePath)) {
      if (!record || !record.pairId) continue
      this.pairs.set(record.pairId, {
        ...record,
        desktopSocket: null,
        mobileSockets: new Set(),
        desktopOnline: false,
        mobileOnline: false,
        messageLog: Array.isArray(record.messageLog) ? record.messageLog : [],
      })
    }
  }

  persistPairs() {
    if (!this.persistencePath) return
    const serialized = [...this.pairs.values()].map(pair => ({
      pairId: pair.pairId,
      pairingSessionId: pair.pairingSessionId,
      createdAt: pair.createdAt,
      revokedAt: pair.revokedAt,
      mobileDeviceId: pair.mobileDeviceId,
      mobileDeviceName: pair.mobileDeviceName,
      desktopDeviceName: pair.desktopDeviceName,
      lastSeenDesktopAt: pair.lastSeenDesktopAt,
      lastSeenMobileAt: pair.lastSeenMobileAt,
      mobileWsTokenHash: pair.mobileWsTokenHash,
      desktopTokenHash: pair.desktopTokenHash,
      desktopBridgeInfo: pair.desktopBridgeInfo,
      messageLog: pair.messageLog,
    }))
    savePairsToDisk(this.persistencePath, serialized)
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => this.runHeartbeatTick(), this.heartbeatIntervalMs)
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref()
  }

  stopHeartbeat() {
    if (!this.heartbeatTimer) return
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  runHeartbeatTick() {
    const current = this.now()
    const seen = new Set()
    const checkConnection = connection => {
      if (!connection || connection.closed || seen.has(connection)) return
      seen.add(connection)
      const lastPongAt = typeof connection.lastPongAt === 'number' ? connection.lastPongAt : current
      if (current - lastPongAt > this.staleConnectionMs) {
        connection.close(1001, 'stale_connection')
        return
      }
      if (typeof connection.sendPing === 'function') connection.sendPing()
    }
    for (const session of this.sessions.values()) checkConnection(session.desktopSocket)
    for (const pair of this.pairs.values()) {
      checkConnection(pair.desktopSocket)
      for (const mobileSocket of pair.mobileSockets) checkConnection(mobileSocket)
    }
    this.cleanupExpiredSessions()
    this.cleanupStalePairs()
    // `sessions` are in-memory only (short-lived QR flow, fine to lose on
    // restart); `pairs` are persisted to disk when persistencePath is set
    // (see store.js) so a redeploy doesn't silently break every paired
    // device. Pairs now live until explicitly disconnected — log size
    // periodically so unbounded growth is at least observable.
    console.log(`wi-control-plane heartbeat: sessions=${this.sessions.size} pairs=${this.pairs.size}`)
  }

  cleanupStalePairs() {
    const current = this.now()
    let removed = false
    for (const [pairId, pair] of this.pairs.entries()) {
      if (pair.revokedAt && current - new Date(pair.revokedAt).getTime() > this.pairRetentionMs) {
        this.pairs.delete(pairId)
        removed = true
      }
    }
    if (removed) this.persistPairs()
  }

  createPairingSession() {
    this.cleanupExpiredSessions()
    const pairingSessionId = this.id('ps')
    const desktopSessionToken = this.token('dst')
    const oneTimeToken = this.token('ott')
    const expiresAtMs = this.now() + this.pairingTtlMs
    const session = {
      pairingSessionId,
      desktopSessionTokenHash: this.hashToken(desktopSessionToken),
      oneTimeTokenHash: this.hashToken(oneTimeToken),
      createdAt: nowIso(this.now),
      expiresAt: new Date(expiresAtMs).toISOString(),
      claimedAt: null,
      pairId: null,
      desktopSocket: null,
      desktopOnline: false,
      lastSeenDesktopAt: null,
      revokedAt: null,
    }
    this.sessions.set(pairingSessionId, session)
    return {
      pairingSessionId,
      desktopSessionToken,
      qrPayload: `wi://pair?session=${encodeURIComponent(pairingSessionId)}&token=${encodeURIComponent(oneTimeToken)}`,
      expiresAt: session.expiresAt,
    }
  }

  claimPairingSession(input) {
    const pairingSessionId = String(input.pairingSessionId || '')
    const oneTimeToken = String(input.oneTimeToken || '')
    const mobileDeviceId = String(input.mobileDeviceId || '').trim()
    const mobileDeviceName = String(input.mobileDeviceName || '').trim() || 'Wi Mobile'
    if (!pairingSessionId || !oneTimeToken || !mobileDeviceId) {
      return { ok: false, status: 400, error: 'missing_required_fields' }
    }
    const session = this.sessions.get(pairingSessionId)
    if (!session) return { ok: false, status: 404, error: 'pairing_session_not_found' }
    if (session.revokedAt) return { ok: false, status: 410, error: 'pairing_session_revoked' }
    if (this.isExpired(session.expiresAt)) return { ok: false, status: 410, error: 'pairing_session_expired' }
    if (session.claimedAt || session.pairId) return { ok: false, status: 409, error: 'pairing_session_already_claimed' }
    if (!safeEqual(session.oneTimeTokenHash, this.hashToken(oneTimeToken))) {
      return { ok: false, status: 401, error: 'invalid_one_time_token' }
    }

    const pairId = this.id('pair')
    const mobileWsToken = this.token('mws')
    // Durable, pair-scoped desktop credential — unlike desktopSessionToken
    // (tied to this short-lived pairing session), this survives indefinitely
    // so a headless desktop client (e.g. a background bridge process) can
    // reconnect after its own restarts without redoing the QR pairing dance.
    const desktopToken = this.token('dtk')
    const pair = {
      pairId,
      pairingSessionId,
      createdAt: nowIso(this.now),
      revokedAt: null,
      mobileDeviceId,
      mobileDeviceName,
      desktopDeviceName: 'Desktop Browser',
      desktopOnline: Boolean(session.desktopSocket && !session.desktopSocket.closed),
      mobileOnline: false,
      lastSeenDesktopAt: session.desktopSocket && !session.desktopSocket.closed ? nowIso(this.now) : null,
      lastSeenMobileAt: null,
      desktopSocket: session.desktopSocket || null,
      // A pair now supports multiple simultaneous mobile connections (e.g.
      // several browser tabs/visitors sharing one hardwired pair) instead of
      // one replacing the other. AI_TEST_RESPONSE/ERROR and PRESENCE are
      // broadcast to all of them; each client already ignores requestIds it
      // didn't send, so broadcasting is safe without per-request routing.
      mobileSockets: new Set(),
      mobileWsTokenHash: this.hashToken(mobileWsToken),
      desktopTokenHash: this.hashToken(desktopToken),
      desktopBridgeInfo: null,
      messageLog: [],
    }
    session.claimedAt = nowIso(this.now)
    session.pairId = pairId
    this.pairs.set(pairId, pair)
    this.persistPairs()

    if (pair.desktopSocket) {
      pair.desktopSocket.meta = { role: 'desktop', pairId, pairingSessionId }
      // desktopToken is shown here in plaintext exactly once — like
      // mobileWsToken, only the hash is retained server-side afterward, so
      // it can never be re-displayed on a later reconnect.
      this.sendEvent(pair.desktopSocket, 'PAIR_CONFIRMED', {
        pairId,
        status: 'paired',
        desktopDeviceName: pair.desktopDeviceName,
        mobileDeviceName: pair.mobileDeviceName,
        desktopToken,
      })
      this.sendPresence(pair)
    }

    return {
      ok: true,
      status: 200,
      payload: {
        pairId,
        mobileWsToken,
        desktopDeviceName: pair.desktopDeviceName,
        status: 'paired',
      },
    }
  }

  registerDesktopConnection(input) {
    const pairingSessionId = String(input.pairingSessionId || '')
    const token = String(input.token || '')
    const connection = input.connection
    const session = this.sessions.get(pairingSessionId)
    if (!session) return { ok: false, status: 404, error: 'pairing_session_not_found' }
    if (session.revokedAt) return { ok: false, status: 410, error: 'pairing_session_revoked' }
    if (this.isExpired(session.expiresAt)) return { ok: false, status: 410, error: 'pairing_session_expired' }
    if (!safeEqual(session.desktopSessionTokenHash, this.hashToken(token))) {
      return { ok: false, status: 401, error: 'invalid_desktop_session_token' }
    }

    this.evictDesktopSocket(session.desktopSocket, connection)
    session.desktopSocket = connection
    session.desktopOnline = true
    session.lastSeenDesktopAt = nowIso(this.now)
    connection.meta = { role: 'desktop', pairingSessionId, pairId: session.pairId || null }

    this.sendEvent(connection, 'DESKTOP_READY', {
      sessionId: pairingSessionId,
      expiresAt: session.expiresAt,
      status: session.pairId ? 'paired' : 'waiting_for_phone',
    })

    if (session.pairId) {
      const pair = this.pairs.get(session.pairId)
      if (pair && !pair.revokedAt) {
        this.evictDesktopSocket(pair.desktopSocket, connection)
        pair.desktopSocket = connection
        pair.desktopOnline = true
        pair.lastSeenDesktopAt = nowIso(this.now)
        connection.meta = { role: 'desktop', pairingSessionId, pairId: pair.pairId }
        this.sendEvent(connection, 'PAIR_CONFIRMED', {
          pairId: pair.pairId,
          status: 'paired',
          desktopDeviceName: pair.desktopDeviceName,
          mobileDeviceName: pair.mobileDeviceName,
        })
        this.sendPresence(pair)
      }
    }

    return { ok: true, status: 101 }
  }

  // Durable counterpart to registerDesktopConnection: authenticates directly
  // against an established pair's desktopTokenHash instead of a pairing
  // session, so a headless desktop client can reconnect after restarting
  // using only the pairId + desktopToken it was given once at claim time.
  // A connect.html tab (session-based) and a durable-token client can both
  // claim `pair.desktopSocket` independently — whichever registers last wins
  // the slot. The loser is told explicitly via DESKTOP_REPLACED (see
  // evictDesktopSocket) instead of just being dropped, so it can stop
  // retrying instead of fighting the winner for the slot.
  registerDesktopConnectionByPair(input) {
    const pairId = String(input.pairId || '')
    const token = String(input.token || '')
    const connection = input.connection
    const pair = this.pairs.get(pairId)
    if (!pair) return { ok: false, status: 404, error: 'pair_not_found' }
    if (pair.revokedAt) return { ok: false, status: 410, error: 'pair_revoked' }
    if (!pair.desktopTokenHash || !safeEqual(pair.desktopTokenHash, this.hashToken(token))) {
      return { ok: false, status: 401, error: 'invalid_desktop_token' }
    }

    this.evictDesktopSocket(pair.desktopSocket, connection)
    pair.desktopSocket = connection
    pair.desktopOnline = true
    pair.lastSeenDesktopAt = nowIso(this.now)
    connection.meta = { role: 'desktop', pairId, pairingSessionId: pair.pairingSessionId }
    this.sendEvent(connection, 'PAIR_CONFIRMED', {
      pairId: pair.pairId,
      status: 'paired',
      desktopDeviceName: pair.desktopDeviceName,
      mobileDeviceName: pair.mobileDeviceName,
    })
    this.sendPresence(pair)
    return { ok: true, status: 101 }
  }

  registerMobileConnection(input) {
    const pairId = String(input.pairId || '')
    const token = String(input.token || '')
    const connection = input.connection
    const pair = this.pairs.get(pairId)
    if (!pair) return { ok: false, status: 404, error: 'pair_not_found' }
    if (pair.revokedAt) return { ok: false, status: 410, error: 'pair_revoked' }
    if (!safeEqual(pair.mobileWsTokenHash, this.hashToken(token))) {
      return { ok: false, status: 401, error: 'invalid_mobile_ws_token' }
    }

    pair.mobileSockets.add(connection)
    pair.mobileOnline = true
    pair.lastSeenMobileAt = nowIso(this.now)
    connection.meta = { role: 'mobile', pairId, pairingSessionId: pair.pairingSessionId }
    this.sendPresence(pair)
    return { ok: true, status: 101 }
  }

  getPairStatus(pairId, authToken) {
    const auth = this.authorizePair(pairId, authToken)
    if (!auth.ok) return auth
    const pair = auth.pair
    return {
      ok: true,
      status: 200,
      payload: {
        pairId: pair.pairId,
        desktopOnline: pair.desktopOnline,
        mobileOnline: pair.mobileOnline,
        status: pair.revokedAt ? 'disconnected' : 'paired',
        desktopDeviceName: pair.desktopDeviceName,
        mobileDeviceName: pair.mobileDeviceName,
        lastSeenDesktopAt: pair.lastSeenDesktopAt,
        lastSeenMobileAt: pair.lastSeenMobileAt,
      },
    }
  }

  disconnectPair(pairId, authToken, reason = 'user_disconnected') {
    const auth = this.authorizePair(pairId, authToken)
    if (!auth.ok) return auth
    const pair = auth.pair
    if (!pair.revokedAt) pair.revokedAt = nowIso(this.now)
    pair.desktopOnline = false
    pair.mobileOnline = false
    pair.lastSeenDesktopAt = pair.lastSeenDesktopAt || nowIso(this.now)
    pair.lastSeenMobileAt = pair.lastSeenMobileAt || nowIso(this.now)
    const event = { reason, pairId: pair.pairId }
    this.sendEvent(pair.desktopSocket, 'PAIR_DISCONNECTED', event)
    if (pair.desktopSocket) pair.desktopSocket.close(1000, reason)
    for (const mobileSocket of pair.mobileSockets) {
      this.sendEvent(mobileSocket, 'PAIR_DISCONNECTED', event)
      mobileSocket.close(1000, reason)
    }
    pair.desktopSocket = null
    pair.mobileSockets.clear()
    const session = this.sessions.get(pair.pairingSessionId)
    if (session) {
      session.revokedAt = pair.revokedAt
      session.desktopSocket = null
      session.desktopOnline = false
    }
    this.persistPairs()
    return { ok: true, status: 200, payload: { ok: true, pairId: pair.pairId, status: 'disconnected' } }
  }

  handleSocketMessage(connection, rawMessage) {
    let message
    try {
      message = JSON.parse(rawMessage)
    } catch (_) {
      this.sendError(connection, 'INVALID_JSON', 'WebSocket payload must be valid JSON.')
      return
    }
    if (!message || typeof message !== 'object') {
      this.sendError(connection, 'INVALID_MESSAGE', 'Message payload must be an object.')
      return
    }
    if (message.type === 'TEST_MESSAGE') {
      this.forwardTestMessage(connection, message)
      return
    }
    if (message.type === 'DISCONNECT') {
      const pairId = connection.meta && connection.meta.pairId
      if (pairId) this.disconnectPair(pairId, this.tokenFromConnection(connection), 'peer_disconnected')
      return
    }
    if (message.type === 'AI_TEST_REQUEST') {
      this.forwardAiTestRequest(connection, message)
      return
    }
    if (message.type === 'AI_TEST_RESPONSE' || message.type === 'AI_TEST_ERROR') {
      this.forwardAiTestResult(connection, message)
      return
    }
    if (message.type === 'PING') {
      this.sendEvent(connection, 'PONG', {})
      return
    }
    if (message.type === 'PONG') {
      return
    }
    if (message.type === 'BRIDGE_READY' || message.type === 'BRIDGE_HEALTH') {
      this.handleBridgeStatus(connection, message)
      return
    }
    this.sendError(connection, 'UNSUPPORTED_MESSAGE_TYPE', 'This message type is not supported in the MVP bridge.')
  }

  handleSocketClose(connection) {
    const meta = connection.meta || {}
    if (meta.role === 'desktop') {
      const session = this.sessions.get(meta.pairingSessionId)
      if (session && session.desktopSocket === connection) {
        session.desktopSocket = null
        session.desktopOnline = false
      }
      if (meta.pairId) {
        const pair = this.pairs.get(meta.pairId)
        if (pair && pair.desktopSocket === connection) {
          pair.desktopSocket = null
          pair.desktopOnline = false
          this.sendPresence(pair)
        }
      }
      return
    }
    if (meta.role === 'mobile') {
      const pair = this.pairs.get(meta.pairId)
      if (pair && pair.mobileSockets.delete(connection)) {
        pair.mobileOnline = pair.mobileSockets.size > 0
        this.sendPresence(pair)
      }
    }
  }

  forwardTestMessage(connection, message) {
    const text = String((message && message.text) || message?.payload?.text || '').trim().slice(0, 500)
    const claimedPairId = String((message && message.pairId) || '')
    if (!text) {
      this.sendError(connection, 'EMPTY_MESSAGE', 'Test messages require text.')
      return
    }
    const meta = connection.meta || {}
    if (claimedPairId && meta.pairId && claimedPairId !== meta.pairId) {
      this.sendError(connection, 'PAIR_MISMATCH', 'Messages can only be sent to the authenticated pair.')
      return
    }
    const pair = this.pairs.get(meta.pairId)
    if (!pair || pair.revokedAt) {
      this.sendError(connection, 'PAIR_UNAVAILABLE', 'The requested pair is unavailable.')
      return
    }
    const sender = meta.role === 'desktop' ? 'desktop' : 'mobile'
    if (sender === 'desktop') pair.lastSeenDesktopAt = nowIso(this.now)
    else pair.lastSeenMobileAt = nowIso(this.now)
    const event = {
      type: 'TEST_MESSAGE',
      pairId: pair.pairId,
      from: sender,
      id: this.id('msg'),
      payload: {
        text,
        sentAt: nowIso(this.now),
      },
    }
    pair.messageLog.push(event)
    if (pair.messageLog.length > 50) pair.messageLog.shift()
    this.sendEvent(connection, 'TEST_MESSAGE', event)
    if (sender === 'desktop') {
      for (const mobileSocket of pair.mobileSockets) this.sendEvent(mobileSocket, 'TEST_MESSAGE', event)
    } else if (pair.desktopSocket) {
      this.sendEvent(pair.desktopSocket, 'TEST_MESSAGE', event)
    }
    this.sendPresence(pair)
  }

  // Mobile → desktop. Stateless forward (no messageLog, no echo back to the
  // sender) — unlike TEST_MESSAGE this isn't a chat, it's a single
  // request/response exchange the desktop bridge answers directly.
  forwardAiTestRequest(connection, message) {
    const meta = connection.meta || {}
    const requestId = String((message && message.requestId) || '').trim()
    const claimedPairId = String((message && message.pairId) || '')
    const prompt = String(message?.payload?.prompt || '').trim()

    if (claimedPairId && meta.pairId && claimedPairId !== meta.pairId) {
      this.sendError(connection, 'PAIR_MISMATCH', 'Messages can only be sent to the authenticated pair.')
      return
    }
    const pair = this.pairs.get(meta.pairId)
    if (!pair || pair.revokedAt) {
      this.sendError(connection, 'PAIR_UNAVAILABLE', 'The requested pair is unavailable.')
      return
    }
    if (!requestId) {
      this.sendEvent(connection, 'AI_TEST_ERROR', { pairId: pair.pairId, payload: { code: 'INVALID_REQUEST_ID', message: 'Request is missing requestId.' } })
      return
    }
    if (!prompt || Buffer.byteLength(prompt, 'utf8') > AI_TEST_REQUEST_MAX_BYTES) {
      this.sendEvent(connection, 'AI_TEST_ERROR', { pairId: pair.pairId, requestId, payload: { code: 'INVALID_PROMPT', message: 'Prompt is missing or too large.' } })
      return
    }

    pair.lastSeenMobileAt = nowIso(this.now)
    if (!pair.desktopSocket || pair.desktopSocket.closed) {
      this.sendEvent(connection, 'AI_TEST_ERROR', {
        pairId: pair.pairId,
        requestId,
        payload: { code: 'DESKTOP_OFFLINE', message: 'Your Personal AI Computer is offline.' },
      })
      return
    }
    this.sendEvent(pair.desktopSocket, 'AI_TEST_REQUEST', {
      pairId: pair.pairId,
      requestId,
      payload: { prompt },
    })
  }

  // Desktop → mobile. pairId is re-keyed from the server-trusted connection
  // meta, not the desktop bridge's own claimed message.pairId.
  forwardAiTestResult(connection, message) {
    const meta = connection.meta || {}
    if (meta.role !== 'desktop') return
    const pair = this.pairs.get(meta.pairId)
    if (!pair || pair.revokedAt || pair.mobileSockets.size === 0) return
    const requestId = String((message && message.requestId) || '')
    // Broadcast rather than route to a single originating socket: each
    // mobile client tracks its own pending requestIds and ignores ones it
    // didn't send, so this is safe with multiple concurrent tabs/visitors.
    for (const mobileSocket of pair.mobileSockets) {
      this.sendEvent(mobileSocket, message.type, {
        pairId: pair.pairId,
        requestId,
        payload: (message && message.payload) || {},
      })
    }
  }

  // Informational only — lets the mobile side eventually show which model
  // the paired desktop bridge is running. Never rejects the connection.
  handleBridgeStatus(connection, message) {
    const meta = connection.meta || {}
    if (meta.role !== 'desktop') return
    const pair = this.pairs.get(meta.pairId)
    if (!pair) return
    const payload = (message && message.payload) || {}
    pair.desktopBridgeInfo = {
      client: String(payload.client || 'desktop-bridge'),
      model: String(payload.model || ''),
      updatedAt: nowIso(this.now),
    }
  }

  sendPresence(pair) {
    const payload = {
      type: 'PRESENCE',
      pairId: pair.pairId,
      desktopOnline: pair.desktopOnline,
      mobileOnline: pair.mobileOnline,
      status: pair.revokedAt ? 'disconnected' : 'paired',
      desktopDeviceName: pair.desktopDeviceName,
      mobileDeviceName: pair.mobileDeviceName,
      lastSeenDesktopAt: pair.lastSeenDesktopAt,
      lastSeenMobileAt: pair.lastSeenMobileAt,
      messages: pair.messageLog,
    }
    this.sendEvent(pair.desktopSocket, 'PRESENCE', payload)
    for (const mobileSocket of pair.mobileSockets) this.sendEvent(mobileSocket, 'PRESENCE', payload)
  }

  sendEvent(connection, type, payload) {
    if (!connection || connection.closed) return
    const normalizedPayload = payload && typeof payload === 'object' ? payload : {}
    connection.sendJson({ type, ...normalizedPayload })
  }

  sendError(connection, code, message) {
    this.sendEvent(connection, 'ERROR', { code, message })
  }

  // A plain close(1000, 'replaced') is indistinguishable from a random
  // network drop to the client that just lost the slot — it has no way to
  // know another connection took over, so it just reconnects and re-claims
  // the slot, which fights whichever connection just won it (this was the
  // "online/offline flapping" reported when a connect.html tab and a
  // headless bridge were both alive for the same pair). Telling the loser
  // explicitly via a distinct error code lets it stand down instead.
  evictDesktopSocket(existingSocket, newConnection) {
    if (!existingSocket || existingSocket === newConnection || existingSocket.closed) return
    this.sendEvent(existingSocket, 'ERROR', {
      code: 'DESKTOP_REPLACED',
      message: 'Another connection took over this desktop pairing.',
    })
    existingSocket.close(1000, 'replaced')
  }

  authorizePair(pairId, authToken) {
    const pair = this.pairs.get(String(pairId || ''))
    if (!pair) return { ok: false, status: 404, error: 'pair_not_found' }
    const provided = String(authToken || '')
    const session = this.sessions.get(pair.pairingSessionId)
    const desktopSessionOkay = session && safeEqual(session.desktopSessionTokenHash, this.hashToken(provided))
    const desktopTokenOkay = pair.desktopTokenHash && safeEqual(pair.desktopTokenHash, this.hashToken(provided))
    const mobileOkay = safeEqual(pair.mobileWsTokenHash, this.hashToken(provided))
    if (!desktopSessionOkay && !desktopTokenOkay && !mobileOkay) return { ok: false, status: 401, error: 'unauthorized' }
    return { ok: true, pair }
  }

  cleanupExpiredSessions() {
    const current = this.now()
    for (const [sessionId, session] of this.sessions.entries()) {
      if (!session.pairId && new Date(session.expiresAt).getTime() <= current) {
        if (session.desktopSocket) {
          this.sendError(session.desktopSocket, 'PAIRING_EXPIRED', 'This QR code has expired.')
          session.desktopSocket.close(1000, 'pairing_session_expired')
        }
        this.sessions.delete(sessionId)
      }
    }
  }

  hashToken(token) {
    return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex')
  }

  token(prefix) {
    return `${prefix}_${this.randomBytes(16).toString('hex')}`
  }

  id(prefix) {
    return `${prefix}_${this.randomBytes(8).toString('hex')}`
  }

  isExpired(expiresAt) {
    return new Date(expiresAt).getTime() <= this.now()
  }

  tokenFromConnection(connection) {
    return connection && connection.authToken ? connection.authToken : ''
  }
}

module.exports = {
  PersonalAiComputerService,
}
