const express = require('express')
const router = express.Router()
const auth = require('../middlewares/authMiddleware')
const User = require('../models/userModel')
const StockMovement = require('../models/stockMovementModel')
const Stock = require('../models/stockModel')
const { v4: uuidv4 } = require('uuid')
const jwt = require('jsonwebtoken')

const normalize = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[^a-z0-9]/g, '')

const JWT_SECRET = process.env.JWT_SECRET

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

// Lightweight token resolver for endpoints that want to be lenient (e.g., pending transfer alerts)
function tryPickToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || ''
  let token = ''
  if (typeof header === 'string' && header.length > 0) {
    const m = header.match(/^\s*Bearer\s+(.+)$/i)
    if (m && m[1]) token = m[1].trim()
    else if (header.length > 20) {
      const parts = header.trim().split(/\s+/)
      token = parts.length > 1 ? parts[parts.length - 1] : parts[0]
    }
  }
  if (!token && req.query && typeof req.query.token === 'string') token = String(req.query.token).trim()
  if (!token && req.query && typeof req.query.tokenkey === 'string') token = String(req.query.tokenkey).trim()
  if (!token && req.body && typeof req.body.token === 'string') token = String(req.body.token).trim()
  if (!token && req.body && typeof req.body.tokenkey === 'string') token = String(req.body.tokenkey).trim()
  return token || null
}

function tryVerifyToken(rawToken) {
  if (!rawToken) return null
  try {
    return jwt.verify(rawToken, JWT_SECRET || 'shantha_motors')
  } catch (e) {
    if (JWT_SECRET && JWT_SECRET !== 'shantha_motors') {
      try { return jwt.verify(rawToken, 'shantha_motors') } catch (_) {}
    }
  }
  return null
}

async function resolveUserOptional(req) {
  const token = tryPickToken(req)
  const verified = tryVerifyToken(token)
  if (!verified?.userId) return null
  try {
    const user = await User.findById(verified.userId).select('role name email primaryBranch branches')
    if (!user) return null
    return { userId: user._id, role: String(user.role || '').toLowerCase(), name: user.name || user.email || '', user }
  } catch {
    return null
  }
}

// Minimal admin/owner/backend guard for destructive actions
async function requireAdminOwner(req, res, next) {
  try {
    const userId = String(req.userId || '')
    if (!userId || !/^[0-9a-fA-F]{24}$/.test(userId)) return res.status(401).send({ success: false, message: 'Unauthorized' })
    const u = await User.findById(userId).select('role')
    const role = String(u?.role || '').toLowerCase()
    if (role === 'admin' || role === 'owner' || role === 'backend') return next()
    return res.status(403).send({ success: false, message: 'Forbidden' })
  } catch (e) {
    return res.status(401).send({ success: false, message: 'Unauthorized' })
  }
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
    const limit = Math.min(Math.max(parseInt(req.query.limit || '1000', 10), 1), 1000)
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
  const transferStatus = String(m?.transferStatus || 'completed').toLowerCase()
  const transferAdmitted = transferStatus === 'admitted' || transferStatus === 'completed'
  if (act === 'add') return m.sourceBranch || null
  if (act === 'transfer') {
    if (!transferAdmitted) return m.sourceBranch || null
    return m.targetBranch || null
  }
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
      // Move stock to targetBranch after admit; keep in source while pending/rejected
      const transferStatus = String(movement?.transferStatus || 'completed').toLowerCase()
      const transferAdmitted = transferStatus === 'admitted' || transferStatus === 'completed'
      const existing = await Stock.findOne({ chassisNo })
      const prevBranch = existing?.sourceBranch || movement.sourceBranch || ''
      const stayBranch = movement.sourceBranch || prevBranch
      const nextBranch = transferAdmitted
        ? (movement.targetBranch || existing?.sourceBranch || '')
        : stayBranch
      const update = {
        ...baseVehicle,
        sourceBranch: nextBranch,
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

// Recompute Stock snapshot for a chassis from the latest non-deleted movement
async function recomputeStockForChassis(chassisNo) {
  try {
    const ch = String(chassisNo || '').trim().toUpperCase()
    if (!ch) return null
    const latest = await StockMovement.findOne({ chassisNo: ch, deleted: { $ne: true } }).sort({ createdAt: -1 })
    if (!latest) {
      // No movement remains, remove snapshot document if present
      await Stock.deleteOne({ chassisNo: ch })
      return null
    }
    return await applyMovementToStock(latest)
  } catch (e) {
    console.error('recomputeStockForChassis failed', e?.message || e)
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
            transferStatus: m.transferStatus || 'completed',
            resolvedByName: m.resolvedByName || undefined,
            resolvedAt: m.resolvedAt || undefined,
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
            transferStatus: m.transferStatus || 'completed',
            resolvedByName: m.resolvedByName || undefined,
            resolvedAt: m.resolvedAt || undefined,
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

// Pending transfer notifications for target branch users
router.get('/transfers/pending', async (req, res) => {
  try {
    const resolved = await resolveUserOptional(req)
    const role = String(resolved?.role || '').toLowerCase()
    const allowAll = ['admin', 'owner', 'backend'].includes(role)
    let branchName = String(req.query.branch || '').trim()
    const wantsAll = allowAll && branchName.toLowerCase() === 'all'
    if (!branchName || (!allowAll && branchName.toLowerCase() === 'all')) {
      branchName = resolved ? await getBranchNameForUser(resolved.userId) : ''
    }
    const branchKey = normalize(branchName)
    const filter = { action: 'transfer', transferStatus: 'pending', deleted: { $ne: true } }
    if (!wantsAll) {
      if (branchKey) filter.targetBranchKey = branchKey
      else return res.status(400).json({ success: false, message: 'Branch is required for pending transfers' })
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit || '500', 10), 1), 1000)
    const items = await StockMovement.find(filter).sort({ createdAt: 1 }).limit(limit)
    return res.json({ success: true, count: items.length, branch: wantsAll ? 'all' : (branchName || null), role: role || 'guest', data: items })
  } catch (err) {
    console.error('GET /stocks/transfers/pending failed', err)
    return res.status(500).json({ success: false, message: 'Failed to fetch pending transfers', detail: err.message })
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
      transferStatus: 'completed',
      resolvedBy: null,
      resolvedByName: null,
      resolvedAt: null,
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
      payload.transferStatus = 'pending'
      const existingPending = await StockMovement.findOne({
        chassisNo: payload.chassisNo,
        action: 'transfer',
        transferStatus: 'pending',
        deleted: { $ne: true },
      })
      if (existingPending) {
        return res.status(409).json({ success: false, message: 'A pending transfer already exists for this chassis' })
      }
    } else {
      payload.transferStatus = 'completed'
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

// Admit a pending transfer into the target branch
router.post('/:id/admit', auth, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ success: false, message: 'Invalid id' })
    const me = await User.findById(req.userId).select('role name email')
    const role = String(me?.role || '').toLowerCase()
    const isPriv = ['admin', 'owner', 'backend'].includes(role)
    const userBranch = await getBranchNameForUser(req.userId)

    const movement = await StockMovement.findOne({ movementId: id, deleted: { $ne: true } })
    if (!movement || movement.action !== 'transfer') {
      return res.status(404).json({ success: false, message: 'Transfer not found' })
    }
    if (String(movement.transferStatus || 'completed').toLowerCase() !== 'pending') {
      return res.status(400).json({ success: false, message: 'Transfer already resolved' })
    }

    const targetKey = normalize(movement.targetBranch)
    const userBranchKey = normalize(userBranch)
    if (!isPriv && (!userBranchKey || userBranchKey !== targetKey)) {
      return res.status(403).json({ success: false, message: 'Not authorized to admit for this branch' })
    }

    movement.transferStatus = 'admitted'
    movement.resolvedAt = new Date()
    movement.resolvedBy = req.userId
    movement.resolvedByName = me?.name || me?.email || 'user'
    const note = String(req.body?.notes || '').trim()
    if (note) movement.notes = movement.notes ? `${movement.notes} | Admit: ${note}` : `Admit: ${note}`
    await movement.save()
    await applyMovementToStock(movement)
    return res.json({ success: true, data: movement })
  } catch (err) {
    console.error('POST /stocks/:id/admit failed', err)
    return res.status(500).json({ success: false, message: 'Failed to admit transfer', detail: err.message })
  }
})

// Reject a pending transfer (keeps stock in source branch)
router.post('/:id/reject', auth, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ success: false, message: 'Invalid id' })
    const me = await User.findById(req.userId).select('role name email')
    const role = String(me?.role || '').toLowerCase()
    const isPriv = ['admin', 'owner', 'backend'].includes(role)
    const userBranch = await getBranchNameForUser(req.userId)

    const movement = await StockMovement.findOne({ movementId: id, deleted: { $ne: true } })
    if (!movement || movement.action !== 'transfer') {
      return res.status(404).json({ success: false, message: 'Transfer not found' })
    }
    if (String(movement.transferStatus || 'completed').toLowerCase() !== 'pending') {
      return res.status(400).json({ success: false, message: 'Transfer already resolved' })
    }

    const targetKey = normalize(movement.targetBranch)
    const userBranchKey = normalize(userBranch)
    if (!isPriv && (!userBranchKey || userBranchKey !== targetKey)) {
      return res.status(403).json({ success: false, message: 'Not authorized to reject for this branch' })
    }

    movement.transferStatus = 'rejected'
    movement.resolvedAt = new Date()
    movement.resolvedBy = req.userId
    movement.resolvedByName = me?.name || me?.email || 'user'
    const reason = String(req.body?.reason || req.body?.notes || '').trim()
    if (reason) movement.notes = movement.notes ? `${movement.notes} | Reject: ${reason}` : `Reject: ${reason}`
    await movement.save()
    await applyMovementToStock(movement)
    return res.json({ success: true, data: movement })
  } catch (err) {
    console.error('POST /stocks/:id/reject failed', err)
    return res.status(500).json({ success: false, message: 'Failed to reject transfer', detail: err.message })
  }
})

// Update by movementId
router.patch('/:id', auth, requireAdminOwner, async (req, res) => {
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
      Transfer_Status: 'transferStatus',
      transferStatus: 'transferStatus',
      resolvedBy: 'resolvedBy',
      resolvedByName: 'resolvedByName',
      resolvedAt: 'resolvedAt',
    }
    Object.entries(map).forEach(([k, v]) => {
      const val = from[k] ?? from[v]
      if (val !== undefined) patch[v] = val
    })

    if (patch.sourceBranch) patch.sourceBranchKey = normalize(patch.sourceBranch)
    if (patch.targetBranch) patch.targetBranchKey = normalize(patch.targetBranch)

    const updated = await StockMovement.findOneAndUpdate({ movementId: id }, patch, { new: true })
    if (!updated) return res.status(404).json({ success: false, message: 'Movement not found' })
    // Recompute based on the actual latest movement for this chassis
    await recomputeStockForChassis(updated.chassisNo)
    return res.json({ success: true, data: updated })
  } catch (err) {
    console.error('PATCH /stocks/:id failed', err)
    return res.status(500).json({ success: false, message: 'Failed to update stock movement', detail: err.message })
  }
})

// Soft-delete a movement and recompute snapshot
router.delete('/:id', auth, requireAdminOwner, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ success: false, message: 'Invalid id' })
    const updated = await StockMovement.findOneAndUpdate({ movementId: id }, { deleted: true }, { new: true })
    if (!updated) return res.status(404).json({ success: false, message: 'Movement not found' })
    await recomputeStockForChassis(updated.chassisNo)
    return res.json({ success: true })
  } catch (err) {
    console.error('DELETE /stocks/:id failed', err)
    return res.status(500).json({ success: false, message: 'Failed to delete stock movement', detail: err.message })
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

    const limit = Math.min(Math.max(parseInt(req.query.limit || '1000', 10), 1), 1000)
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
