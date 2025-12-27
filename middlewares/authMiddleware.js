const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET && process.env.NODE_ENV !== 'production') {
  console.warn('JWT_SECRET not set; using insecure default for development')
}

module.exports = function (req, res, next) {
  try {
    const header = req.headers.authorization || req.headers.Authorization || ''
    let token = ''
    if (typeof header === 'string' && header.length > 0) {
      // Accept any case for the scheme and strip it if present (e.g., 'bearer', 'Bearer')
      const m = header.match(/^\s*Bearer\s+(.+)$/i)
      if (m && m[1]) {
        token = m[1].trim()
      } else if (header.length > 20) {
        // If header contains only the token (no scheme), try to salvage last whitespace-separated part
        const parts = header.trim().split(/\s+/)
        token = parts.length > 1 ? parts[parts.length - 1] : parts[0]
      }
    }
    // Accept token in query/body for environments where proxies strip headers
    if (!token && req.query && typeof req.query.token === 'string') {
      token = String(req.query.token).trim()
    }
    // Legacy param name used by older frontend builds
    if (!token && req.query && typeof req.query.tokenkey === 'string') {
      token = String(req.query.tokenkey).trim()
    }
    if (!token && req.body && typeof req.body.token === 'string') {
      token = String(req.body.token).trim()
    }
    if (!token && req.body && typeof req.body.tokenkey === 'string') {
      token = String(req.body.tokenkey).trim()
    }
    if (!token) throw new Error('Missing token')

    let verifiedToken
    try {
      verifiedToken = jwt.verify(token, JWT_SECRET || 'shantha_motors')
    } catch (e) {
      // Compatibility: if the server secret changed, accept tokens signed with the old
      // dev default ('shantha_motors') to avoid breaking existing sessions.
      // Remove this fallback once all clients have refreshed tokens.
      if (JWT_SECRET && JWT_SECRET !== 'shantha_motors') {
        try { verifiedToken = jwt.verify(token, 'shantha_motors') } catch (_) {}
      }
    }
    if (!verifiedToken) throw new Error('Invalid token')
    // Attach userId in a safe place (do not rely only on body)
    req.userId = verifiedToken.userId
    // Keep legacy behavior for existing routes that expect it in body
    req.body.userId = verifiedToken.userId
    next()
  } catch (error) {
    res.status(401).send({ success: false, message: 'Token Invalid' })
  }
}
