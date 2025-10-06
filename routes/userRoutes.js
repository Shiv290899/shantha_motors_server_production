const express = require('express')
const router = express.Router()
const User = require('../models/userModel')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const authMiddleware = require('../middlewares/authMiddleware')
const crypto = require('crypto')
const { sendMail, isMailConfigured } = require('../utils/mailer')

const JWT_SECRET = process.env.JWT_SECRET
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '2d'
const BCRYPT_SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10)
const RESET_TOKEN_EXP_MINUTES = parseInt(process.env.RESET_TOKEN_EXP_MINUTES || '30', 10)
const APP_URL = (process.env.APP_URL).replace(/\/$/, '')
if (!JWT_SECRET && process.env.NODE_ENV !== 'production') {
  console.warn('JWT_SECRET not set; using insecure default for development')
}


router.post('/register', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()
    const phone = req.body.phone ? String(req.body.phone).trim() : undefined

    if (!email || !req.body.password) {
      return res.status(400).send({
        success: false,
        message: 'Email and password are required.',
      })
    }

    req.body.email = email
    if (phone) req.body.phone = phone

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

    const hashedPassword = await bcrypt.hash(req.body.password, BCRYPT_SALT_ROUNDS)
    req.body.password = hashedPassword

    const newUser = new User(req.body)
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

    // Return minimal user profile too so client can show name immediately
    return res.send({
      success: true,
      message: "You've successfully logged in!",
      token: jwtToken,
      user: {
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone,
        id: String(user._id),
      },
    });
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

router.get('/get-valid-user', authMiddleware, async (req, res) => {
  const validUser = await User.findById(req.body.userId).select("-password");

  res.send({
    success: true,
    message: "You are authorized to go to the protected route!",
    data: validUser,
  });
});

module.exports = router;
