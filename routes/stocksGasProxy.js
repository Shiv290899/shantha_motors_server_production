const express = require('express')
const axios = require('axios')

const router = express.Router()

// Point this to your deployed Apps Script Web App URL
const GAS_URL = process.env.STOCKS_GAS_URL || 'https://script.google.com/macros/s/AKfycbzWT7aSLTZl-qW2peDaHMcsW_aA55ttVfheZThFfYpj7sMm09Mg_6Gp2xjc7Z0XNHmwpw/exec'

// GET proxy (list/current/pending)
router.get('/', async (req, res) => {
  try {
    const params = { ...req.query }
    if (!params.action) params.action = 'list'
    const { data } = await axios.get(GAS_URL, { params })
    return res.json(data)
  } catch (err) {
    const status = err?.response?.status || 500
    return res.status(status).json({ ok: false, message: 'Failed to reach GAS (GET)', detail: err?.message || String(err) })
  }
})

// POST proxy (create/update/delete/admit/reject)
router.post('/', async (req, res) => {
  try {
    const payload = req.body || {}
    if (!payload.action) payload.action = 'create'
    const { data } = await axios.post(GAS_URL, payload)
    return res.json(data)
  } catch (err) {
    const status = err?.response?.status || 500
    return res.status(status).json({ ok: false, message: 'Failed to reach GAS (POST)', detail: err?.message || String(err) })
  }
})

module.exports = router
