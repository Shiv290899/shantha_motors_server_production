const express = require('express')
const router = express.Router()
const User = require('../models/userModel')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const authMiddleware = require('../middlewares/authMiddleware')

const JWT_SECRET = process.env.JWT_SECRET
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '2d'
const BCRYPT_SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10)
if (!JWT_SECRET && process.env.NODE_ENV !== 'production') {
  console.warn('JWT_SECRET not set; using insecure default for development')
}

router.post('/register', async (req, res) => {
  try {
    // check if the user already exists
    const userExists = await User.findOne({ email: req.body.email });
    if (userExists) {
      res.send({
        success: false,
        message: "The user already exists!",
      });
    }

    // if not create the user according to the User Model

    // hashing and salting

    // hash password using configured salt rounds
    const hashedPassword = await bcrypt.hash(req.body.password, BCRYPT_SALT_ROUNDS)

    req.body.password = hashedPassword;

    // console.log(password)
    const newUser = await User(req.body);
    await newUser.save();

    res.send({
      success: true,
      message: "User Resgitered Successfully",
    });
  } catch (err) {
    console.log(err);
  }
});

router.post('/login', async (req, res) => {
  try {
    const user = await User.findOne({ email: req.body.email });

    console.log(user);

    if (!user) {
      res.send({
        success: false,
        message: "user does not exist Please Register",
      });
    }

    // validate password

    const validPassword = await bcrypt.compare(
      req.body.password,
      user.password
    );

    if (!validPassword) {
      res.status(401).send({
        success: false,
        message: "Sorry, invalid password entered!",
      });
    }

    const jwtToken = jwt.sign({ userId: user._id }, JWT_SECRET || 'shantha_motors', {
      expiresIn: JWT_EXPIRES_IN,
    })

    // Return minimal user profile too so client can show name immediately
    res.send({
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
    console.error(error);
  }
});

router.get('/get-valid-user', authMiddleware, async (req, res) => {
  const validUser = await User.findById(req.body.userId).select("-password");

  res.send({
    success: true,
    message: "You are authorized to go to the protected route!",
    data: validUser,
  });
});

module.exports = router;
