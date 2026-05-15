const router = require('express').Router()
const { body } = require('express-validator')
const {
  register,
  login,
  getMe,
  updateMe,
  verifyEmail,
  verifyCode,
  resendCode,
} = require('../controllers/authController')
const { authenticate } = require('../middleware/auth')
const { validate } = require('../middleware/errorHandler')

// Register – donors and creators
router.post('/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 100 }),
    body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('role').optional().isIn(['donor', 'creator']).withMessage('Role must be donor or creator'),
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

// Legacy token-based verification (deprecated)
router.post('/verify-email',
  [body('token').notEmpty().withMessage('Verification token is required')],
  validate, verifyEmail
)

// 6-digit code verification
router.post('/verify-code',
  [
    body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
    body('code').isLength({ min: 6, max: 6 }).withMessage('6-digit code required'),
  ],
  validate, verifyCode
)

// Resend verification code
router.post('/resend-code',
  [body('email').isEmail().withMessage('Valid email is required').normalizeEmail()],
  validate, resendCode
)

module.exports = router