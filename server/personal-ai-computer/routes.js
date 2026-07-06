function readJson(body) {
  if (!body) return {}
  return JSON.parse(body)
}

// Fixed-window per-IP limiter guarding session creation from being spammed
// (each session lives in memory until claimed or expired, so unbounded
// creation is a cheap way to exhaust memory).
const SESSION_RATE_LIMIT_MAX = Number(process.env.WI_PAIRING_SESSION_RATE_LIMIT_PER_MINUTE || 20)
const SESSION_RATE_LIMIT_WINDOW_MS = 60_000
const sessionRateMap = new Map()

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'
}

function isSessionCreationRateLimited(req) {
  if (!SESSION_RATE_LIMIT_MAX || SESSION_RATE_LIMIT_MAX < 1) return false
  const now = Date.now()
  const ip = clientIp(req)
  const bucket = sessionRateMap.get(ip)
  if (!bucket || now >= bucket.reset) {
    sessionRateMap.set(ip, { count: 1, reset: now + SESSION_RATE_LIMIT_WINDOW_MS })
    return false
  }
  bucket.count += 1
  if (sessionRateMap.size > 10_000) {
    for (const [key, value] of sessionRateMap.entries()) if (now >= value.reset) sessionRateMap.delete(key)
  }
  return bucket.count > SESSION_RATE_LIMIT_MAX
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '')
  if (!header.startsWith('Bearer ')) return ''
  return header.slice('Bearer '.length).trim()
}

function errorBody(code, message) {
  return {
    ok: false,
    code: String(code || 'REQUEST_FAILED').toUpperCase(),
    message: message || 'Request failed.',
  }
}

function humanizeError(code) {
  switch (code) {
    case 'missing_required_fields': return 'The request is missing required pairing fields.'
    case 'pairing_session_not_found': return 'This pairing session does not exist.'
    case 'pairing_session_revoked': return 'This pairing session has already been revoked.'
    case 'pairing_session_expired': return 'This QR code has expired.'
    case 'pairing_session_already_claimed': return 'This QR code has already been claimed.'
    case 'invalid_one_time_token': return 'This QR code token is invalid.'
    case 'pair_not_found': return 'This pair could not be found.'
    case 'pair_revoked': return 'This pair has already been disconnected.'
    case 'unauthorized': return 'This request is not authorized for the selected pair.'
    default: return 'Request failed.'
  }
}

async function handlePersonalAiComputerRoute(req, res, url, body, service, sendJson) {
  if (req.method === 'POST' && url.pathname === '/v1/pairing/session') {
    if (isSessionCreationRateLimited(req)) {
      sendJson(req, res, 429, errorBody('rate_limited', 'Too many pairing sessions created. Try again shortly.'))
      return true
    }
    const session = service.createPairingSession()
    sendJson(req, res, 201, session)
    return true
  }

  if (req.method === 'POST' && url.pathname === '/v1/pairing/claim') {
    const result = service.claimPairingSession(readJson(body))
    sendJson(req, res, result.status, result.ok ? result.payload : errorBody(result.error, humanizeError(result.error)))
    return true
  }

  const statusMatch = url.pathname.match(/^\/v1\/pairs\/([^/]+)\/status$/)
  if (req.method === 'GET' && statusMatch) {
    const result = service.getPairStatus(statusMatch[1], bearerToken(req))
    sendJson(req, res, result.status, result.ok ? result.payload : errorBody(result.error, humanizeError(result.error)))
    return true
  }

  const disconnectMatch = url.pathname.match(/^\/v1\/pairs\/([^/]+)\/disconnect$/)
  if (req.method === 'POST' && disconnectMatch) {
    let reason = 'user_disconnected'
    try {
      const parsed = readJson(body)
      if (parsed && typeof parsed.reason === 'string' && parsed.reason.trim()) reason = parsed.reason.trim()
    } catch (_) {}
    const result = service.disconnectPair(disconnectMatch[1], bearerToken(req), reason)
    sendJson(req, res, result.status, result.ok ? result.payload : errorBody(result.error, humanizeError(result.error)))
    return true
  }

  return false
}

module.exports = {
  handlePersonalAiComputerRoute,
}
