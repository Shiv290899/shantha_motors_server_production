const express = require('express')
const router = express.Router()
const auth = require('../middlewares/authMiddleware')
const { sendWhatsappText } = require('../utils/whatsapp')

// Send a WhatsApp message via Business Cloud API from the configured business number
// POST /api/whatsapp/send { to: string, text: string }
router.post('/send', auth, async (req, res) => {
  try {
    const { to, text, preview_url } = req.body || {}
    if (!to || !text) {
      return res.status(400).json({ success: false, message: 'Missing to or text' })
    }
    const data = await sendWhatsappText({ to, text, preview_url })
    return res.json({ success: true, data })
  } catch (err) {
    const status = err.code === 'WA_NOT_CONFIGURED' ? 503 : 500
    return res.status(status).json({ success: false, message: err.message, code: err.code, details: err.details })
  }
})

module.exports = router

