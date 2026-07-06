const crypto = require('crypto')

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
    // A pair with no open socket on either side for this long is treated as
    // abandoned (app closed / tab closed without an explicit disconnect).
    this.pairAbandonedMs = options.pairAbandonedMs || 30 * 60_000
    this.sessions = new Map()
    this.pairs = new Map()
    this.heartbeatTimer = null
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
      checkConnection(pair.mobileSocket)
    }
    this.cleanupExpiredSessions()
    this.cleanupStalePairs()
  }

  cleanupStalePairs() {
    const current = this.now()
    for (const [pairId, pair] of this.pairs.entries()) {
      if (pair.revokedAt) {
        if (current - new Date(pair.revokedAt).getTime() > this.pairRetentionMs) {
          this.pairs.delete(pairId)
        }
        continue
      }
      const bothOffline = (!pair.desktopSocket || pair.desktopSocket.closed) && (!pair.mobileSocket || pair.mobileSocket.closed)
      if (!bothOffline) continue
      const lastActivityMs = Math.max(
        pair.lastSeenDesktopAt ? new Date(pair.lastSeenDesktopAt).getTime() : 0,
        pair.lastSeenMobileAt ? new Date(pair.lastSeenMobileAt).getTime() : 0,
        new Date(pair.createdAt).getTime(),
      )
      if (current - lastActivityMs > this.pairAbandonedMs) {
        // Both sides are already offline (bothOffline, above) so there is no
        // live socket left to notify — just drop the abandoned pair.
        const session = this.sessions.get(pair.pairingSessionId)
        if (session) {
          session.revokedAt = nowIso(this.now)
          session.desktopSocket = null
          session.desktopOnline = false
        }
        this.pairs.delete(pairId)
      }
    }
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
      mobileSocket: null,
      mobileWsTokenHash: this.hashToken(mobileWsToken),
      messageLog: [],
    }
    session.claimedAt = nowIso(this.now)
    session.pairId = pairId
    this.pairs.set(pairId, pair)

    if (pair.desktopSocket) {
      pair.desktopSocket.meta = { role: 'desktop', pairId, pairingSessionId }
      this.sendEvent(pair.desktopSocket, 'PAIR_CONFIRMED', {
        pairId,
        status: 'paired',
        desktopDeviceName: pair.desktopDeviceName,
        mobileDeviceName: pair.mobileDeviceName,
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

    if (session.desktopSocket && session.desktopSocket !== connection) {
      session.desktopSocket.close(1000, 'replaced')
    }
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

    if (pair.mobileSocket && pair.mobileSocket !== connection) {
      pair.mobileSocket.close(1000, 'replaced')
    }
    pair.mobileSocket = connection
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
    this.sendEvent(pair.mobileSocket, 'PAIR_DISCONNECTED', event)
    if (pair.desktopSocket) pair.desktopSocket.close(1000, reason)
    if (pair.mobileSocket) pair.mobileSocket.close(1000, reason)
    pair.desktopSocket = null
    pair.mobileSocket = null
    const session = this.sessions.get(pair.pairingSessionId)
    if (session) {
      session.revokedAt = pair.revokedAt
      session.desktopSocket = null
      session.desktopOnline = false
    }
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
      if (pair && pair.mobileSocket === connection) {
        pair.mobileSocket = null
        pair.mobileOnline = false
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
    const peer = sender === 'desktop' ? pair.mobileSocket : pair.desktopSocket
    if (peer) this.sendEvent(peer, 'TEST_MESSAGE', event)
    this.sendPresence(pair)
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
    this.sendEvent(pair.mobileSocket, 'PRESENCE', payload)
  }

  sendEvent(connection, type, payload) {
    if (!connection || connection.closed) return
    const normalizedPayload = payload && typeof payload === 'object' ? payload : {}
    connection.sendJson({ type, ...normalizedPayload })
  }

  sendError(connection, code, message) {
    this.sendEvent(connection, 'ERROR', { code, message })
  }

  authorizePair(pairId, authToken) {
    const pair = this.pairs.get(String(pairId || ''))
    if (!pair) return { ok: false, status: 404, error: 'pair_not_found' }
    const provided = String(authToken || '')
    const session = this.sessions.get(pair.pairingSessionId)
    const desktopOkay = session && safeEqual(session.desktopSessionTokenHash, this.hashToken(provided))
    const mobileOkay = safeEqual(pair.mobileWsTokenHash, this.hashToken(provided))
    if (!desktopOkay && !mobileOkay) return { ok: false, status: 401, error: 'unauthorized' }
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
