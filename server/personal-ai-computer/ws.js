const crypto = require('crypto')

function websocketAccept(key) {
  return crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'utf8')
    .digest('base64')
}

class MinimalWebSocketConnection {
  constructor(socket, onMessage, onClose) {
    this.socket = socket
    this.onMessage = onMessage
    this.onClose = onClose
    this.closed = false
    this.buffer = Buffer.alloc(0)
    this.meta = {}
    this.authToken = ''

    socket.on('data', chunk => this.handleData(chunk))
    socket.on('close', () => this.handleClose())
    socket.on('end', () => this.handleClose())
    socket.on('error', () => this.handleClose())
  }

  sendJson(payload) {
    this.sendText(JSON.stringify(payload))
  }

  sendText(text) {
    if (this.closed) return
    const body = Buffer.from(String(text || ''), 'utf8')
    this.socket.write(buildFrame(0x1, body))
  }

  close(code = 1000, reason = '') {
    if (this.closed) return
    const reasonBuffer = Buffer.from(String(reason || '').slice(0, 120), 'utf8')
    const payload = Buffer.alloc(2 + reasonBuffer.length)
    payload.writeUInt16BE(code, 0)
    reasonBuffer.copy(payload, 2)
    try {
      this.socket.write(buildFrame(0x8, payload))
    } catch (_) {}
    this.socket.end()
    this.handleClose()
  }

  handleData(chunk) {
    if (this.closed) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const frame = parseFrame(this.buffer)
      if (!frame) return
      this.buffer = this.buffer.subarray(frame.bytesConsumed)
      if (frame.opcode === 0x8) {
        this.close(1000, 'client_closed')
        return
      }
      if (frame.opcode === 0x9) {
        this.socket.write(buildFrame(0xA, frame.payload))
        continue
      }
      if (frame.opcode !== 0x1) continue
      if (frame.fin === false) {
        this.close(1003, 'fragmented_messages_not_supported')
        return
      }
      this.onMessage(this, frame.payload.toString('utf8'))
    }
  }

  handleClose() {
    if (this.closed) return
    this.closed = true
    try { this.onClose(this) } catch (_) {}
  }
}

function buildFrame(opcode, payload) {
  const length = payload.length
  if (length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload])
  }
  if (length < 65536) {
    const header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x80 | opcode
  header[1] = 127
  header.writeBigUInt64BE(BigInt(length), 2)
  return Buffer.concat([header, payload])
}

function parseFrame(buffer) {
  if (buffer.length < 2) return null
  const first = buffer[0]
  const second = buffer[1]
  const fin = Boolean(first & 0x80)
  const opcode = first & 0x0f
  const masked = Boolean(second & 0x80)
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const maskBytes = masked ? 4 : 0
  const needed = offset + maskBytes + length
  if (buffer.length < needed) return null
  let payload = buffer.subarray(offset + maskBytes, needed)
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4)
    payload = Buffer.from(payload)
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
  }
  return { fin, opcode, payload, bytesConsumed: needed }
}

function rejectUpgrade(socket, statusCode, message) {
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: text/plain\r\n' +
    '\r\n'
  )
  socket.destroy()
}

function handlePersonalAiComputerUpgrade(req, socket, head, service) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (!['/v1/pairing/ws', '/v1/ws/desktop', '/v1/ws/mobile'].includes(url.pathname)) return false
  if (head && head.length) {
    socket.destroy()
    return true
  }
  const key = req.headers['sec-websocket-key']
  if (!key) {
    rejectUpgrade(socket, 400, 'Bad Request')
    return true
  }
  const accept = websocketAccept(String(key))
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n'
  )

  const connection = new MinimalWebSocketConnection(
    socket,
    (conn, message) => service.handleSocketMessage(conn, message),
    conn => service.handleSocketClose(conn),
  )

  const role = url.pathname === '/v1/ws/desktop'
    ? 'desktop'
    : url.pathname === '/v1/ws/mobile'
      ? 'mobile'
      : String(url.searchParams.get('role') || '')
  const token = String(url.searchParams.get('token') || '')
  connection.authToken = token
  const result = role === 'desktop'
    ? service.registerDesktopConnection({
      pairingSessionId: url.searchParams.get('pairingSessionId') || url.searchParams.get('session'),
      token,
      connection,
    })
    : service.registerMobileConnection({
      pairId: url.searchParams.get('pairId'),
      token,
      connection,
    })

  if (!result.ok) {
    connection.sendJson({ type: 'ERROR', code: String(result.error || 'UPGRADE_REJECTED').toUpperCase(), message: String(result.error || 'Upgrade rejected.') })
    connection.close(1008, result.error)
  }
  return true
}

module.exports = {
  handlePersonalAiComputerUpgrade,
}
