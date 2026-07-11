const fs = require('fs')
const path = require('path')

// Persists only the pairs themselves (pairId, token hashes, device names) —
// never live sockets or online/offline state, which are meaningless across
// a process restart and get reset fresh as clients reconnect. Pairing
// `sessions` (the short-lived QR-code flow) are intentionally not persisted:
// they're a few minutes old at most, so a restart mid-QR-scan just means
// re-scanning, not a broken long-lived pairing.
function loadPairsFromDisk(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.pairs)) return []
    return parsed.pairs
  } catch (error) {
    if (error.code === 'ENOENT') return []
    console.warn(`wi-control-plane: failed to load persisted pairs from ${filePath}: ${error.message}`)
    return []
  }
}

// Write-to-temp-then-rename so a crash mid-write can never leave a
// truncated/corrupt store file for the next boot to choke on.
function savePairsToDisk(filePath, pairs) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tmpPath = `${filePath}.tmp-${process.pid}`
    fs.writeFileSync(tmpPath, JSON.stringify({ pairs, savedAt: new Date().toISOString() }, null, 2))
    fs.renameSync(tmpPath, filePath)
  } catch (error) {
    console.warn(`wi-control-plane: failed to persist pairs to ${filePath}: ${error.message}`)
  }
}

module.exports = { loadPairsFromDisk, savePairsToDisk }
