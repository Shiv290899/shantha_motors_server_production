const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET && process.env.NODE_ENV !== 'production') {
  console.warn('JWT_SECRET not set; using insecure default for development')
}

module.exports = function (req, res, next) {
  try {
    const header = req.headers.authorization || ''
    const token = header.split(' ')[1]
    if (!token) throw new Error('Missing token')

    const verifiedToken = jwt.verify(token, JWT_SECRET || 'shantha_motors')

    req.body.userId = verifiedToken.userId
    next()
  } catch (error) {
    res.status(401).send({ success: false, message: 'Token Invalid' })
  }
}
