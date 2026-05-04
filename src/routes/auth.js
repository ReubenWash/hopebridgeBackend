const router = require('express').Router()
const { body } = require('express-validator')
const {
  register,
  login,
  getMe,
  updateMe,
  verifyEmail,
  verifyCode
} = require('../controllers/authController')
const { authenticate } = require('../middleware/auth')
const { validate } = require('../middleware/errorHandler')

// Registration – only creators (role forced in controller)
router.post('/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 100 }),
    body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    // role field is no longer accepted; controller always sets 'creator'
  ],
  validate, register
)

router.post('/login',
  [
    body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validate, login
)

router.get('/me',  authenticate, getMe)
router.patch('/me', authenticate, updateMe)

// ⚠️ Deprecated token‑based verification (kept for legacy, but new flow uses /verify-code)
router.post('/verify-email',
  [
    body('token').notEmpty().withMessage('Verification token is required'),
  ],
  validate, verifyEmail
)

// ✅ New 6‑digit code verification
router.post('/verify-code',
  [
    body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
    body('code').isLength({ min: 6, max: 6 }).withMessage('6‑digit code required'),
  ],
  validate, verifyCode
)

module.exports = router