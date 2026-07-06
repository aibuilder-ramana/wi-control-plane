const http = require('http')
const fs = require('fs')
const path = require('path')

const { handlePersonalAiComputerRoute } = require('./server/personal-ai-computer/routes')
const { handlePersonalAiComputerUpgrade } = require('./server/personal-ai-computer/ws')
const { PersonalAiComputerService } = require('./server/personal-ai-computer/service')

const PORT = Number(process.env.PORT || 3001)
const PUBLIC_DIR = path.join(__dirname, 'public')
const pairingTtlMs = Number(process.env.WI_PAIRING_TTL_MS || 5 * 60_000)

const personalAiComputerService = new PersonalAiComputerService({ pairingTtlMs })
personalAiComputerService.startHeartbeat()

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
}

function corsHeaders(req) {
  const origin = String(req.headers.origin || '*')
  return {
    'Access-Control-Allow-Origin': origin === 'null' ? '*' : origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  }
}

function send(req, res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    ...corsHeaders(req),
    ...headers,
  })
  res.end(body)
}

function sendJson(req, res, status, payload) {
  send(req, res, status, JSON.stringify(payload), {
    'Content-Type': 'application/json; charset=utf-8',
  })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > 1_000_000) {
        reject(new Error('Body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function serveStatic(req, res, url) {
  const pathname = url.pathname === '/' ? '/connect.html' : url.pathname
  const filePath = path.join(PUBLIC_DIR, pathname.replace(/^\/+/, ''))
  const normalized = path.normalize(filePath)
  // Prefix must include the separator, otherwise a sibling directory like
  // `${PUBLIC_DIR}-evil` would incorrectly pass a bare startsWith(PUBLIC_DIR).
  if (normalized !== PUBLIC_DIR && !normalized.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(req, res, 403, { ok: false, error: 'Forbidden' })
    return
  }
  fs.readFile(normalized, (err, data) => {
    if (err) {
      sendJson(req, res, 404, { ok: false, error: 'Not found' })
      return
    }
    const ext = path.extname(normalized).toLowerCase()
    send(req, res, 200, req.method === 'HEAD' ? '' : data, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    })
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'OPTIONS') {
    send(req, res, 204, '')
    return
  }

  if (req.method === 'GET' && url.pathname === '/connect') {
    res.writeHead(302, { Location: '/connect.html' })
    res.end()
    return
  }

  if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/api/health')) {
    sendJson(req, res, 200, {
      ok: true,
      service: 'wi-control-plane',
      feature: 'personal-ai-computer-pairing',
      timestamp: new Date().toISOString(),
    })
    return
  }

  if (url.pathname.startsWith('/v1/')) {
    try {
      const body = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : ''
      const handled = await handlePersonalAiComputerRoute(req, res, url, body, personalAiComputerService, sendJson)
      if (handled) return
      sendJson(req, res, 404, { ok: false, error: 'Not found' })
    } catch (error) {
      sendJson(req, res, 500, { ok: false, error: error.message || 'Internal server error' })
    }
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(req, res, 405, { ok: false, error: 'Method not allowed' })
    return
  }

  serveStatic(req, res, url)
})

server.on('upgrade', (req, socket, head) => {
  if (handlePersonalAiComputerUpgrade(req, socket, head, personalAiComputerService)) return
  socket.destroy()
})

server.listen(PORT, () => {
  console.log(`Wi Control Plane listening on :${PORT}`)
})
