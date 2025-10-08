const express = require('express')
const router = express.Router()
const User = require('../models/userModel')
const Branch = require('../models/branchModel')
const mongoose = require('mongoose')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const authMiddleware = require('../middlewares/authMiddleware')
const crypto = require('crypto')
const { sendMail, isMailConfigured } = require('../utils/mailer')

const JWT_SECRET = process.env.JWT_SECRET
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '2d'
const BCRYPT_SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10)
const RESET_TOKEN_EXP_MINUTES = parseInt(process.env.RESET_TOKEN_EXP_MINUTES || '30', 10)
const APP_URL = (process.env.APP_URL || 'http://localhost:5174').replace(/\/$/, '')
if (!JWT_SECRET && process.env.NODE_ENV !== 'production') {
  console.warn('JWT_SECRET not set; using insecure default for development')
}

// Minimal admin/owner guard reused across routes
async function requireAdminOwner(req, res, next) {
  try {
    const userId = String(req.userId || req.body.userId || '')
    if (!/^[0-9a-fA-F]{24}$/.test(userId)) {
      return res.status(401).send({ success: false, message: 'Unauthorized' })
    }
    // Allow open editing when explicitly enabled (use with caution)
    if (process.env.USER_CRUD_OPEN === 'true') return next()
    const me = await User.findById(userId).select('role')
    const role = String(me?.role || '').toLowerCase()
    if (role === 'admin' || role === 'owner') return next()
    return res.status(403).send({ success: false, message: 'Forbidden: admin/owner only' })
  } catch (err) {
    console.error('requireAdminOwner error', err)
    return res.status(401).send({ success: false, message: 'Unauthorized' })
  }
}


router.post('/register', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim()
    const email = String(req.body.email || '').trim().toLowerCase()
    const phone = req.body.phone ? String(req.body.phone).trim() : undefined

    if (!name || !email || !req.body.password) {
      return res.status(400).send({
        success: false,
        message: 'Name, email and password are required.',
      })
    }

    // Build a safe payload — do not allow role/status/branch escalation via public register
    const incomingPassword = String(req.body.password)
    const safeBody = {
      name,
      email,
      ...(phone ? { phone } : {}),
      // role is forced to basic user for self-registration
      role: 'user',
    }

    const duplicate = await User.findOne({
      $or: [
        { email },
        ...(phone ? [{ phone }] : []),
      ],
    })

    if (duplicate) {
      const sameEmail = duplicate.email === email
      const samePhone = phone && duplicate.phone === phone
      let message = 'An account with these details already exists.'
      if (sameEmail && samePhone) {
        message = 'Both email and mobile number are already registered.'
      } else if (sameEmail) {
        message = 'Email is already registered.'
      } else if (samePhone) {
        message = 'Mobile number is already registered.'
      }

      return res.status(409).send({
        success: false,
        message,
      })
    }

    const hashedPassword = await bcrypt.hash(incomingPassword, BCRYPT_SALT_ROUNDS)
    const newUser = new User({ ...safeBody, password: hashedPassword })
    await newUser.save()

    return res.status(201).send({
      success: true,
      message: 'User registered successfully.',
    })
  } catch (err) {
    if (err?.code === 11000) {
      const keys = Object.keys(err.keyPattern || {})
      let message = 'Account already exists.'
      if (keys.includes('email')) message = 'Email is already registered.'
      else if (keys.includes('phone')) message = 'Mobile number is already registered.'
      return res.status(409).send({ success: false, message })
    }

    console.error(err)
    return res.status(500).send({
      success: false,
      message: 'Could not complete registration. Please try again later.',
    })
  }
})

router.post('/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()
    const user = await User.findOne({ email })

    if (!user) {
      return res.status(404).send({
        success: false,
        message: 'User does not exist. Please register.',
      })
    }

    const validPassword = await bcrypt.compare(
      req.body.password,
      user.password
    )

    if (!validPassword) {
      return res.status(401).send({
        success: false,
        message: 'Sorry, invalid password entered!',
      })
    }

    const jwtToken = jwt.sign({ userId: user._id }, JWT_SECRET || 'shantha_motors', {
      expiresIn: JWT_EXPIRES_IN,
    })

    // Enrich the user payload so the client can render branch/name immediately without a second fetch
    const userDoc = await User.findById(user._id)
      .select('-password')
      .populate('primaryBranch', 'name')
      .populate({ path: 'branches', select: 'name', options: { limit: 3 } })

    const full = userDoc ? userDoc.toJSON() : null
    let branchName = null
    if (userDoc?.primaryBranch && userDoc.primaryBranch.name) branchName = userDoc.primaryBranch.name
    else if (Array.isArray(userDoc?.branches) && userDoc.branches.length) branchName = userDoc.branches[0]?.name || null
    if (full) {
      full.formDefaults = full.formDefaults || {}
      if (!full.formDefaults.staffName) full.formDefaults.staffName = full.name || ''
      if (!full.formDefaults.branchId) full.formDefaults.branchId = userDoc.primaryBranch?._id || (Array.isArray(userDoc.branches) ? userDoc.branches[0]?._id : undefined)
      if (branchName) full.formDefaults.branchName = branchName
    }

    return res.send({
      success: true,
      message: "You've successfully logged in!",
      token: jwtToken,
      user: full || {
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone,
        id: String(user._id),
      },
    })
  } catch (error) {
    console.error(error)
    return res.status(500).send({
      success: false,
      message: 'Unable to process login right now. Please try again later.',
    })
  }
});

router.post('/forgot-password', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()

    if (!email) {
      return res.status(400).send({
        success: false,
        message: 'Email is required.',
      })
    }

    const user = await User.findOne({ email })
    if (!user) {
      return res.status(404).send({
        success: false,
        message: 'We could not find an account with that email.',
      })
    }

    const rawToken = crypto.randomBytes(32).toString('hex')
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex')

    user.resetPasswordToken = hashedToken
    user.resetPasswordExpiresAt = new Date(Date.now() + RESET_TOKEN_EXP_MINUTES * 60 * 1000)
    await user.save()

    const resetLink = `${APP_URL}/login?resetToken=${rawToken}`

    const responsePayload = {
      success: true,
      message: 'If the account exists, we have sent password reset instructions.',
    }

    if (isMailConfigured()) {
      try {
        await sendMail({
          to: email,
          subject: 'Reset your Shantha Motors password',
          text: `You requested a password reset. Use the link below to set a new password.\n\n${resetLink}\n\nIf you did not request this, you can ignore this email.`,
          html: `
            <p>You requested a password reset for Shantha Motors.</p>
            <p><a href="${resetLink}" target="_blank" rel="noopener">Click here to choose a new password</a>.</p>
            <p>If the button doesn't work, paste this link in your browser:</p>
            <p><code>${resetLink}</code></p>
            <p>This link expires in ${RESET_TOKEN_EXP_MINUTES} minutes.</p>
          `,
        })
        responsePayload.emailSent = true
      } catch (mailError) {
        console.error('Failed to send reset email:', mailError)
        return res.status(500).send({
          success: false,
          message: 'Could not send reset email. Please try again later.',
        })
      }
    } else if (process.env.NODE_ENV !== 'production') {
      responsePayload.devResetToken = rawToken
      responsePayload.devResetExpiry = user.resetPasswordExpiresAt
    }

    return res.send(responsePayload)
  } catch (error) {
    console.error(error)
    return res.status(500).send({
      success: false,
      message: 'Unable to start password reset. Please try again later.',
    })
  }
})

router.post('/reset-password', async (req, res) => {
  try {
    const token = String(req.body.token || '').trim()
    const password = req.body.password

    if (!token || !password) {
      return res.status(400).send({
        success: false,
        message: 'Token and new password are required.',
      })
    }

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex')
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpiresAt: { $gt: new Date() },
    })

    if (!user) {
      return res.status(400).send({
        success: false,
        message: 'Reset link is invalid or has expired.',
      })
    }

    const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS)
    user.password = hashedPassword
    user.resetPasswordToken = undefined
    user.resetPasswordExpiresAt = undefined
    await user.save()

    return res.send({
      success: true,
      message: 'Password has been reset successfully.',
    })
  } catch (error) {
    console.error(error)
    return res.status(500).send({
      success: false,
      message: 'Unable to reset password. Please try again later.',
    })
  }
})

// List users (admin/owner only)
router.get('/', authMiddleware, requireAdminOwner, async (req, res) => {
  try {
    const { q, role, status, branch, limit = 100, page = 1 } = req.query || {}
    const filter = {}
    if (q) {
      const re = new RegExp(String(q), 'i')
      filter.$or = [
        { name: re },
        { email: re },
        { phone: re },
        { jobTitle: re },
        { employeeCode: re },
      ]
    }
    if (role) filter.role = role
    if (status) filter.status = status
    if (branch && mongoose.Types.ObjectId.isValid(String(branch))) {
      const b = new mongoose.Types.ObjectId(String(branch))
      filter.$or = [...(filter.$or || []), { primaryBranch: b }, { branches: b }]
    }
    const skip = (Math.max(parseInt(page, 10), 1) - 1) * Math.max(parseInt(limit, 10), 1)
    const [items, total] = await Promise.all([
      User.find(filter)
        .select('-password -resetPasswordToken -resetPasswordExpiresAt')
        .populate('primaryBranch', 'name code')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10)),
      User.countDocuments(filter),
    ])
    return res.json({ success: true, data: { items, total } })
  } catch (err) {
    console.error('GET /users failed', err)
    return res.status(500).json({ success: false, message: 'Failed to fetch users' })
  }
})

// Public read-only list (no auth). Mirrors filters of the secured list.
router.get('/public', async (req, res) => {
  try {
    const { q, role, status, branch, limit = 100, page = 1 } = req.query || {}
    const filter = {}
    if (q) {
      const re = new RegExp(String(q), 'i')
      filter.$or = [
        { name: re },
        { email: re },
        { phone: re },
        { jobTitle: re },
        { employeeCode: re },
      ]
    }
    if (role) filter.role = role
    if (status) filter.status = status
    if (branch && mongoose.Types.ObjectId.isValid(String(branch))) {
      const b = new mongoose.Types.ObjectId(String(branch))
      filter.$or = [...(filter.$or || []), { primaryBranch: b }, { branches: b }]
    }
    const skip = (Math.max(parseInt(page, 10), 1) - 1) * Math.max(parseInt(limit, 10), 1)
    const projection = '-password -resetPasswordToken -resetPasswordExpiresAt'
    const [items, total] = await Promise.all([
      User.find(filter)
        .select(projection)
        .populate('primaryBranch', 'name code')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10)),
      User.countDocuments(filter),
    ])
    return res.json({ success: true, data: { items, total }, public: true })
  } catch (err) {
    console.error('GET /users/public failed', err)
    return res.status(500).json({ success: false, message: 'Failed to fetch users' })
  }
})

// Admin create user
router.post('/', authMiddleware, requireAdminOwner, async (req, res) => {
  try {
    const body = req.body || {}
    const name = String(body.name || '').trim()
    const email = String(body.email || '').trim().toLowerCase()
    const role = String(body.role || 'user').trim()
    const passwordPlain = String(body.password || '')

    if (!name || !email || !passwordPlain) {
      return res.status(400).json({ success: false, message: 'name, email, password are required' })
    }

    // Unique checks for email/phone
    const dup = await User.findOne({ $or: [{ email }, ...(body.phone ? [{ phone: String(body.phone).trim() }] : [])] })
    if (dup) {
      const sameEmail = dup.email === email
      const samePhone = body.phone && dup.phone === String(body.phone).trim()
      return res.status(409).json({ success: false, message: sameEmail ? 'Email already exists' : samePhone ? 'Phone already exists' : 'User already exists' })
    }

    const payload = {
      name,
      email,
      password: await bcrypt.hash(passwordPlain, BCRYPT_SALT_ROUNDS),
      role,
      status: body.status || 'active',
      ...(body.phone ? { phone: String(body.phone).trim() } : {}),
      ...(body.jobTitle ? { jobTitle: String(body.jobTitle).trim() } : {}),
      ...(body.employeeCode ? { employeeCode: String(body.employeeCode).trim() } : {}),
      ...(body.primaryBranch && mongoose.Types.ObjectId.isValid(String(body.primaryBranch)) ? { primaryBranch: body.primaryBranch } : {}),
      ...(Array.isArray(body.branches) ? { branches: body.branches.filter(v => mongoose.Types.ObjectId.isValid(String(v))) } : {}),
      ...(typeof body.canSwitchBranch === 'boolean' ? { canSwitchBranch: body.canSwitchBranch } : {}),
    }

    const created = await User.create(payload)
    return res.status(201).json({ success: true, message: 'User created', data: created })
  } catch (err) {
    if (err?.code === 11000) {
      const keys = Object.keys(err.keyPattern || {})
      const msg = keys.includes('email') ? 'Email already exists' : keys.includes('phone') ? 'Phone already exists' : 'Duplicate key'
      return res.status(409).json({ success: false, message: msg })
    }
    if (err?.name === 'ValidationError') {
      const details = Object.values(err.errors || {}).map(e => e?.message).join('; ')
      return res.status(400).json({ success: false, message: details || 'Validation failed' })
    }
    console.error('POST /users failed', err)
    return res.status(500).json({ success: false, message: 'Failed to create user' })
  }
})

// Admin update user (full)
router.put('/:id', authMiddleware, requireAdminOwner, async (req, res) => {
  try {
    const id = String(req.params.id || '')
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' })
    }
    const body = { ...req.body }
    delete body.userId
    if (body.email) body.email = String(body.email).trim().toLowerCase()
    if (body.name) body.name = String(body.name).trim()
    if (body.phone != null) body.phone = body.phone === '' ? undefined : String(body.phone).trim()
    if (typeof body.canSwitchBranch !== 'undefined') body.canSwitchBranch = !!body.canSwitchBranch

    if (body.password) {
      body.password = await bcrypt.hash(String(body.password), BCRYPT_SALT_ROUNDS)
    } else {
      delete body.password
    }

    if (Object.prototype.hasOwnProperty.call(body, 'branches')) {
      if (Array.isArray(body.branches)) {
        body.branches = body.branches.filter(v => mongoose.Types.ObjectId.isValid(String(v)))
      } else if (body.branches == null) {
        body.branches = []
      } else {
        delete body.branches
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'primaryBranch')) {
      if (!body.primaryBranch || !mongoose.Types.ObjectId.isValid(String(body.primaryBranch))) {
        body.primaryBranch = undefined
      }
    }

    const updated = await User.findByIdAndUpdate(id, body, { new: true, runValidators: true })
    if (!updated) return res.status(404).json({ success: false, message: 'User not found' })
    return res.json({ success: true, message: 'User updated', data: updated })
  } catch (err) {
    if (err?.code === 11000) {
      const keys = Object.keys(err.keyPattern || {})
      const msg = keys.includes('email') ? 'Email already exists' : keys.includes('phone') ? 'Phone already exists' : 'Duplicate key'
      return res.status(409).json({ success: false, message: msg })
    }
    if (err?.name === 'ValidationError') {
      const details = Object.values(err.errors || {}).map(e => e?.message).join('; ')
      return res.status(400).json({ success: false, message: details || 'Validation failed' })
    }
    console.error('PUT /users/:id failed', err)
    return res.status(500).json({ success: false, message: 'Failed to update user' })
  }
})

// Admin delete user
router.delete('/:id', authMiddleware, requireAdminOwner, async (req, res) => {
  try {
    const id = String(req.params.id || '')
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' })
    }
    const deleted = await User.findByIdAndDelete(id)
    if (!deleted) return res.status(404).json({ success: false, message: 'User not found' })
    return res.json({ success: true, message: 'User deleted' })
  } catch (err) {
    console.error('DELETE /users/:id failed', err)
    return res.status(500).json({ success: false, message: 'Failed to delete user' })
  }
})

router.get('/get-valid-user', authMiddleware, async (req, res) => {
  try {
    const userDoc = await User.findById(req.body.userId)
      .select('-password')
      .populate('primaryBranch', 'name')
      .populate({ path: 'branches', select: 'name', options: { limit: 3 } })

    if (!userDoc) {
      return res.status(404).send({ success: false, message: 'User not found' })
    }

    const user = userDoc.toJSON()
    let branchName = null
    if (userDoc?.primaryBranch && userDoc.primaryBranch.name) {
      branchName = userDoc.primaryBranch.name
    } else if (Array.isArray(userDoc?.branches) && userDoc.branches.length) {
      const b0 = userDoc.branches[0]
      branchName = b0?.name || null
    }

    if (!user.formDefaults) user.formDefaults = {}
    if (branchName) user.formDefaults.branchName = branchName

    return res.send({
      success: true,
      message: 'You are authorized to go to the protected route!',
      data: user,
    })
  } catch (err) {
    console.error('GET /users/get-valid-user failed', err)
    return res.status(500).send({ success: false, message: 'Could not fetch current user' })
  }
})

// Keep legacy PATCH for role/branch add-set operations

// PATCH user for role/branch updates (admin/owner only)
router.patch('/:id', authMiddleware, requireAdminOwner, async (req, res) => {
  try {
    const userIdParam = String(req.params.id || '')
    if (!mongoose.Types.ObjectId.isValid(userIdParam)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' })
    }

    const { role, primaryBranch, branches } = req.body || {}

    const update = { $set: {}, $addToSet: {} }

    if (role) update.$set.role = role
    if (primaryBranch && mongoose.Types.ObjectId.isValid(primaryBranch)) {
      update.$set.primaryBranch = primaryBranch
    }
    if (Array.isArray(branches)) {
      const clean = branches
        .map(String)
        .filter((v) => mongoose.Types.ObjectId.isValid(v))
      if (clean.length) update.$addToSet.branches = { $each: clean }
    }

    if (Object.keys(update.$set).length === 0) delete update.$set
    if (!update.$addToSet.branches) delete update.$addToSet
    if (!update.$set && !update.$addToSet) {
      return res.status(400).json({ success: false, message: 'No valid fields to update' })
    }

    const user = await User.findByIdAndUpdate(userIdParam, update, {
      new: true,
      runValidators: true,
    })
    if (!user) return res.status(404).json({ success: false, message: 'User not found' })

    // Optional reverse link on Branch
    if (primaryBranch && mongoose.Types.ObjectId.isValid(primaryBranch)) {
      await Branch.updateOne({ _id: primaryBranch }, { $addToSet: { staff: user._id } })
    }

    return res.json({ success: true, data: user })
  } catch (err) {
    if (err?.name === 'ValidationError') {
      const details = Object.values(err.errors || {}).map((e) => e?.message).join('; ')
      return res.status(400).json({ success: false, message: details || 'Validation failed' })
    }
    console.error('PATCH /users/:id failed', err)
    return res.status(500).json({ success: false, message: 'Failed to update user' })
  }
})

module.exports = router;
