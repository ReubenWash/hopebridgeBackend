const router = require('express').Router()
const { body } = require('express-validator')
const {
  createDonation,
  getCampaignDonations,
  createPayPalOrder,
  capturePayPalOrder,
  getCreatorPaymentMethod,
  saveCreatorPaymentMethod,
  getMyDonations,                         // ← added
} = require('../controllers/donationController')
const { authenticate, requireCreator } = require('../middleware/auth')
const { validate } = require('../middleware/errorHandler')

// ── Public: card donation ────────────────────────────────────────
router.post('/',
  [
    body('campaign_id').isInt({ min: 1 }).withMessage('Valid campaign ID is required'),
    body('donor_name').trim().notEmpty().withMessage('Your name is required'),
    body('donor_email').isEmail().withMessage('Valid email is required').normalizeEmail(),
    body('amount').isFloat({ min: 1 }).withMessage('Amount must be at least $1'),
    body('is_monthly').optional().isBoolean(),
  ],
  validate, createDonation
)

// ── Public: PayPal order creation ────────────────────────────────
router.post('/paypal/create-order',
  [
    body('campaign_id').isInt({ min: 1 }).withMessage('Valid campaign ID is required'),
    body('amount').isFloat({ min: 1 }).withMessage('Amount must be at least $1'),
    body('donor_name').optional().trim(),
    body('donor_email').optional().isEmail().normalizeEmail(),
    body('message').optional().trim(),
    body('is_monthly').optional().isBoolean(),
  ],
  validate, createPayPalOrder
)

// ── Public: PayPal capture ───────────────────────────────────────
router.post('/paypal/capture-order',
  [
    body('orderID').notEmpty().withMessage('PayPal order ID is required'),
  ],
  validate, capturePayPalOrder
)

// ── Authenticated: get logged‑in user's donation history ─────────
router.get('/my', authenticate, getMyDonations)

// ── Creator: view donations for their campaign ───────────────────
router.get('/campaign/:id', authenticate, requireCreator, getCampaignDonations)

// ── Creator: get / save payment method ───────────────────────────
router.get('/creator/payment-method', authenticate, requireCreator, getCreatorPaymentMethod)
router.put('/creator/payment-method',
  authenticate,
  requireCreator,
  [
    body('paypal_email').isEmail().withMessage('Valid PayPal email is required'),
  ],
  validate, saveCreatorPaymentMethod
)

module.exports = router