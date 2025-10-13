const express = require('express')
const router = express.Router()
const auth = require('../middlewares/authMiddleware')
const User = require('../models/userModel')
const StockMovement = require('../models/stockMovementModel')
const Stock = require('../models/stockModel')
const { v4: uuidv4 } = require('uuid')

const normalize = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[^a-z0-9]/g, '')

async function getBranchNameForUser(userId) {
  const user = await User.findById(userId)
    .select('primaryBranch branches role name')
    .populate('primaryBranch', 'name')
    .populate('branches', 'name')
  if (!user) return null
  if (user.primaryBranch?.name) return user.primaryBranch.name
  if (Array.isArray(user.branches) && user.branches[0]?.name) return user.branches[0].name
  return null
}

// List with optional branch scoping
// GET /api/stocks?branch=Name&mode=source|target|any
router.get('/', auth, async (req, res) => {
  try {
    const me = await User.findById(req.userId).select('role')
    const role = String(me?.role || '').toLowerCase()
    const staffLike = ['staff', 'mechanic', 'employees'].includes(role)
    let branchName = String(req.query.branch || '').trim()
    if (!branchName) branchName = await getBranchNameForUser(req.userId)
    const branchKey = normalize(branchName)
    const mode = String(req.query.mode || (staffLike ? 'source' : 'any')).toLowerCase()

    const filter = { deleted: { $ne: true } }
    if (branchKey) {
      if (mode === 'source') filter.sourceBranchKey = branchKey
      else if (mode === 'target') filter.targetBranchKey = branchKey
      else filter.$or = [{ sourceBranchKey: branchKey }, { targetBranchKey: branchKey }]
    }

    // Simple pagination params
    const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10), 1), 1000)
    const page = Math.max(parseInt(req.query.page || '1', 10), 1)
    const skip = (page - 1) * limit

    const [items, total] = await Promise.all([
      StockMovement.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      StockMovement.countDocuments(filter),
    ])

    return res.json({ success: true, count: items.length, total, branch: branchName || null, mode, role, data: items })
  } catch (err) {
    console.error('GET /stocks failed', err)
    return res.status(500).json({ success: false, message: 'Failed to fetch stocks', detail: err.message })
  }
})

function deriveCurrentBranch(m) {
  const act = String(m?.action || '').toLowerCase()
  if (act === 'add') return m.sourceBranch || null
  if (act === 'transfer') return m.targetBranch || null
  if (act === 'return' || act === 'invoice') return null
  return null
}

async function applyMovementToStock(movement) {
  try {
    const act = String(movement?.action || '').toLowerCase()
    const chassisNo = String(movement?.chassisNo || '').trim().toUpperCase()
    if (!chassisNo) return null

    const baseVehicle = {
      company: movement.company || undefined,
      model: movement.model || undefined,
      variant: movement.variant || undefined,
      color: movement.color || undefined,
    }

    if (act === 'add') {
      // Create or update stock as present in sourceBranch
      const update = {
        ...baseVehicle,
        sourceBranch: movement.sourceBranch || '',
        status: 'in_stock',
        lastMovementId: movement.movementId,
      }
      const doc = await Stock.findOneAndUpdate(
        { chassisNo },
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      )
      return doc
    }

    if (act === 'transfer') {
      // Move stock to targetBranch; keep previous for UI
      const existing = await Stock.findOne({ chassisNo })
      const prevBranch = existing?.sourceBranch || movement.sourceBranch || ''
      const update = {
        ...baseVehicle,
        sourceBranch: movement.targetBranch || existing?.sourceBranch || '',
        lastSourceBranch: prevBranch,
        status: 'in_stock',
        lastMovementId: movement.movementId,
      }
      const doc = await Stock.findOneAndUpdate(
        { chassisNo },
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      )
      return doc
    }

    if (act === 'return' || act === 'invoice') {
      // Mark stock as out of inventory
      const update = {
        ...baseVehicle,
        status: 'out',
        sourceBranch: '',
        lastMovementId: movement.movementId,
      }
      const doc = await Stock.findOneAndUpdate(
        { chassisNo },
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      )
      return doc
    }

    return null
  } catch (e) {
    console.error('applyMovementToStock failed', e?.message || e)
    return null
  }
}

// Current inventory per chassis (latest movement), optional branch filter
// GET /api/stocks/current?branch=Name
router.get('/current', auth, async (req, res) => {
  try {
    const me = await User.findById(req.userId).select('role')
    const role = String(me?.role || '').toLowerCase()
    const staffLike = ['staff', 'mechanic', 'employees'].includes(role)
    let branchName = String(req.query.branch || '').trim()
    if (!branchName) branchName = await getBranchNameForUser(req.userId)
    const branchKey = normalize(branchName)

    // Prefer the current stock snapshot for performance and uniqueness
    const filter = { status: 'in_stock' }
    if (branchKey) filter.sourceBranchKey = branchKey
    let items = await Stock.find(filter).sort({ updatedAt: -1 }).lean()

    // Fallback to movements if snapshot is empty (first-run / migration)
    if (!items || items.length === 0) {
      const docs = await StockMovement.find({ deleted: { $ne: true } }).sort({ createdAt: -1 }).lean()
      const seen = new Set()
      const fallback = []
      for (const m of docs) {
        const ch = String(m.chassisNo || '').trim().toUpperCase()
        if (!ch || seen.has(ch)) continue
        const currentBranch = deriveCurrentBranch(m)
        if (!currentBranch) { seen.add(ch); continue }
        if (branchKey && normalize(currentBranch) !== branchKey) { seen.add(ch); continue }
        const lastSourceBranch = String(m.sourceBranch || '')
        fallback.push({ ...m, sourceBranch: currentBranch, lastSourceBranch })
        seen.add(ch)
      }
      items = fallback
    } else {
      // Hydrate action/notes context from last movement for UI parity
      const ids = items.map((s) => s.lastMovementId).filter(Boolean)
      if (ids.length) {
        const moves = await StockMovement.find({ movementId: { $in: ids } }).lean()
        const byId = new Map(moves.map((m) => [m.movementId, m]))
        items = items.map((s) => {
          const m = byId.get(s.lastMovementId) || {}
          return {
            ...s,
            action: m.action || undefined,
            targetBranch: m.targetBranch || undefined,
            returnTo: m.returnTo || undefined,
            customerName: m.customerName || undefined,
            notes: m.notes || undefined,
            timestamp: m.timestamp || undefined,
            movementId: m.movementId || undefined,
          }
        })
      }
    }

    return res.json({ success: true, count: items.length, branch: branchName || null, role, data: items })
  } catch (err) {
    console.error('GET /stocks/current failed', err)
    return res.status(500).json({ success: false, message: 'Failed to fetch current stock', detail: err.message })
  }
})

// Public current inventory (no auth)
router.get('/current/public', async (req, res) => {
  try {
    const branchName = String(req.query.branch || '').trim()
    const branchKey = normalize(branchName)
    const filter = { status: 'in_stock' }
    if (branchKey) filter.sourceBranchKey = branchKey
    let items = await Stock.find(filter).sort({ updatedAt: -1 }).lean()

    if (!items || items.length === 0) {
      const docs = await StockMovement.find({ deleted: { $ne: true } }).sort({ createdAt: -1 }).lean()
      const seen = new Set()
      const fallback = []
      for (const m of docs) {
        const ch = String(m.chassisNo || '').trim().toUpperCase()
        if (!ch || seen.has(ch)) continue
        const currentBranch = deriveCurrentBranch(m)
        if (!currentBranch) { seen.add(ch); continue }
        if (branchKey && normalize(currentBranch) !== branchKey) { seen.add(ch); continue }
        const lastSourceBranch = String(m.sourceBranch || '')
        fallback.push({ ...m, sourceBranch: currentBranch, lastSourceBranch })
        seen.add(ch)
      }
      items = fallback
    } else {
      const ids = items.map((s) => s.lastMovementId).filter(Boolean)
      if (ids.length) {
        const moves = await StockMovement.find({ movementId: { $in: ids } }).lean()
        const byId = new Map(moves.map((m) => [m.movementId, m]))
        items = items.map((s) => {
          const m = byId.get(s.lastMovementId) || {}
          return {
            ...s,
            action: m.action || undefined,
            targetBranch: m.targetBranch || undefined,
            returnTo: m.returnTo || undefined,
            customerName: m.customerName || undefined,
            notes: m.notes || undefined,
            timestamp: m.timestamp || undefined,
            movementId: m.movementId || undefined,
          }
        })
      }
    }

    return res.json({ success: true, count: items.length, branch: branchName || null, data: items })
  } catch (err) {
    console.error('GET /stocks/current/public failed', err)
    return res.status(500).json({ success: false, message: 'Failed to fetch current stock', detail: err.message })
  }
})

// Create
// Body accepts either a flat payload or a { data: {...sheet-like...} }
router.post('/', auth, async (req, res) => {
  try {
    const me = await User.findById(req.userId).select('role name')
    const role = String(me?.role || '').toLowerCase()
    const staffLike = ['staff', 'mechanic', 'employees'].includes(role)
    const userBranch = await getBranchNameForUser(req.userId)
    const createdByName = String(req.body.createdBy || me?.name || 'system')

    const from = req.body?.data || req.body || {}
    const payload = {
      movementId: from.movementId || uuidv4(),
      chassisNo: from.Chassis_No || from.chassisNo || '',
      company: from.Company || from.company || '',
      model: from.Model || from.model || '',
      variant: from.Variant || from.variant || '',
      color: from.Color || from.color || '',
      action: (from.Action || from.action || '').toString().toLowerCase() || 'transfer',
      targetBranch: from.Target_Branch || from.targetBranch || '',
      returnTo: from.Return_To || from.returnTo || '',
      customerName: from.Customer_Name || from.customerName || '',
      sourceBranch: staffLike ? (userBranch || '') : (from.Source_Branch || from.sourceBranch || userBranch || ''),
      notes: from.Notes || from.notes || '',
      createdByName,
      createdBy: req.userId,
      timestamp: new Date(),
      deleted: false,
    }

    // Normalize chassis and branches
    payload.chassisNo = String(payload.chassisNo || '').trim().toUpperCase()
    payload.sourceBranch = String(payload.sourceBranch || '').trim()
    payload.targetBranch = String(payload.targetBranch || '').trim()

    if (!payload.chassisNo) {
      return res.status(400).json({ success: false, message: 'Chassis number is required' })
    }

    // Find last movement for this chassis to determine current location
    let last = null
    try {
      last = await StockMovement.findOne({ chassisNo: payload.chassisNo, deleted: { $ne: true } }).sort({ createdAt: -1 }).lean()
    } catch {}
    const currentBranch = last ? deriveCurrentBranch(last) : null

    // If user attempted to ADD a chassis that already exists, convert to TRANSFER
    if (payload.action === 'add' && currentBranch) {
      const desiredDest = payload.sourceBranch || userBranch || ''
      if (desiredDest && desiredDest !== currentBranch) {
        payload.action = 'transfer'
        payload.sourceBranch = currentBranch
        payload.targetBranch = desiredDest
        // Optional: annotate why
        if (payload.notes) payload.notes = `${payload.notes} (auto: add→transfer)`
        else payload.notes = '(auto: add→transfer)'
      } else {
        // already present in same branch; keep as no-op-ish add
      }
    }

    // Enforce valid source branch on ADD and keep Stock uniqueness semantics
    if (payload.action === 'add') {
      if (!payload.sourceBranch) {
        return res.status(400).json({ success: false, message: 'Source branch is required for add' })
      }
      // If an active stock already exists with this chassis, prevent duplicate adds
      const existingStock = await Stock.findOne({ chassisNo: payload.chassisNo, status: 'in_stock' }).lean()
      if (existingStock) {
        const existingBranch = String(existingStock.sourceBranch || '')
        // If desired add branch differs from where it currently is, convert to transfer
        if (existingBranch && existingBranch !== payload.sourceBranch) {
          payload.action = 'transfer'
          payload.sourceBranch = existingBranch
          payload.targetBranch = String(payload.targetBranch || '').trim() || String(userBranch || '')
          if (!payload.targetBranch) {
            return res.status(400).json({ success: false, message: 'Target branch is required (auto add→transfer)' })
          }
          if (payload.notes) payload.notes = `${payload.notes} (auto: add→transfer)`
          else payload.notes = '(auto: add→transfer)'
        } else {
          // Already present in the same branch: reject to avoid duplicate record noise
          return res.status(409).json({ success: false, message: 'Chassis already exists in this branch' })
        }
      }
    }

    // For TRANSFER, trust the last known branch as source of truth
    if (payload.action === 'transfer') {
      if (!payload.targetBranch) {
        return res.status(400).json({ success: false, message: 'Target branch is required for transfer' })
      }
      if (currentBranch && payload.sourceBranch !== currentBranch) {
        payload.sourceBranch = currentBranch
      }
      if (payload.sourceBranch && payload.targetBranch && payload.sourceBranch === payload.targetBranch) {
        return res.status(400).json({ success: false, message: 'Source and target branch cannot be the same' })
      }
    }

    const created = await StockMovement.create(payload)
    // Update current Stock snapshot to enforce uniqueness and branch change after transfer
    await applyMovementToStock(created)
    return res.status(201).json({ success: true, data: created })
  } catch (err) {
    console.error('POST /stocks failed', err)
    return res.status(500).json({ success: false, message: 'Failed to create stock movement', detail: err.message })
  }
})

// Update by movementId
router.patch('/:id', auth, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim()
    const from = req.body?.data || req.body || {}
    const patch = {}
    const map = {
      Chassis_No: 'chassisNo',
      Company: 'company',
      Model: 'model',
      Variant: 'variant',
      Color: 'color',
      Action: 'action',
      Target_Branch: 'targetBranch',
      Return_To: 'returnTo',
      Customer_Name: 'customerName',
      Source_Branch: 'sourceBranch',
      Notes: 'notes',
      movementId: 'movementId',
    }
    Object.entries(map).forEach(([k, v]) => {
      const val = from[k] ?? from[v]
      if (val !== undefined) patch[v] = val
    })

    if (patch.sourceBranch) patch.sourceBranchKey = normalize(patch.sourceBranch)
    if (patch.targetBranch) patch.targetBranchKey = normalize(patch.targetBranch)

    const updated = await StockMovement.findOneAndUpdate({ movementId: id }, patch, { new: true })
    if (!updated) return res.status(404).json({ success: false, message: 'Movement not found' })
    // Re-apply to stock snapshot in case relevant fields changed
    await applyMovementToStock(updated)
    return res.json({ success: true, data: updated })
  } catch (err) {
    console.error('PATCH /stocks/:id failed', err)
    return res.status(500).json({ success: false, message: 'Failed to update stock movement', detail: err.message })
  }
})

// Public list (no auth). Useful as a fallback if token validation fails on the client.
// GET /api/stocks/public?branch=Name&mode=source|target|any
router.get('/public', async (req, res) => {
  try {
    const branchName = String(req.query.branch || '').trim()
    const branchKey = normalize(branchName)
    const mode = String(req.query.mode || 'any').toLowerCase()

    const filter = { deleted: { $ne: true } }
    if (branchKey) {
      if (mode === 'source') filter.sourceBranchKey = branchKey
      else if (mode === 'target') filter.targetBranchKey = branchKey
      else filter.$or = [{ sourceBranchKey: branchKey }, { targetBranchKey: branchKey }]
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10), 1), 1000)
    const page = Math.max(parseInt(req.query.page || '1', 10), 1)
    const skip = (page - 1) * limit

    const [items, total] = await Promise.all([
      StockMovement.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      StockMovement.countDocuments(filter),
    ])
    return res.json({ success: true, count: items.length, total, branch: branchName || null, mode, data: items })
  } catch (err) {
    console.error('GET /stocks/public failed', err)
    return res.status(500).json({ success: false, message: 'Failed to fetch stocks', detail: err.message })
  }
})

module.exports = router
