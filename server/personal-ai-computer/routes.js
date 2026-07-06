function readJson(body) {
  if (!body) return {}
  return JSON.parse(body)
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
