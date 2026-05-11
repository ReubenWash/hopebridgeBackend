const router = require('express').Router();
const { body } = require('express-validator');

const {
  createDonation,
  getCampaignDonations,
  createPayPalOrder,
  capturePayPalOrder,
  getCreatorPaymentMethod,
  saveCreatorPaymentMethod,
  getMyDonations,
} = require('../controllers/donationController');

const {
  authenticate,
  requireCreator,
} = require('../middleware/auth');

const { validate } = require('../middleware/errorHandler');

// ─────────────────────────────────────────────
// 🔐 PUBLIC: CARD DONATION
// ─────────────────────────────────────────────
router.post(
  '/',
  [
    body('campaign_id')
      .isInt({ min: 1 })
      .withMessage('Valid campaign ID is required'),

    body('donor_name')
      .trim()
      .notEmpty()
      .withMessage('Your name is required'),

    body('donor_email')
      .isEmail()
      .withMessage('Valid email is required')
      .normalizeEmail(),

    body('amount')
      .isFloat({ min: 1 })
      .withMessage('Amount must be at least $1'),

    body('is_monthly')
      .optional()
      .isBoolean(),
  ],
  validate,
  createDonation
);

// ─────────────────────────────────────────────
// 💳 PAYPAL: CREATE ORDER
// ─────────────────────────────────────────────
router.post(
  '/paypal/create-order',
  [
    body('campaign_id')
      .isInt({ min: 1 })
      .withMessage('Valid campaign ID is required'),

    body('amount')
      .isFloat({ min: 1 })
      .withMessage('Amount must be at least $1'),

    body('donor_name')
      .optional()
      .trim(),

    body('donor_email')
      .optional()
      .isEmail()
      .normalizeEmail(),

    body('message')
      .optional()
      .trim(),

    body('is_monthly')
      .optional()
      .isBoolean(),
  ],
  validate,
  createPayPalOrder
);

// ─────────────────────────────────────────────
// 🔐 PAYPAL: CAPTURE ORDER (SECURED BACKEND VERIFY)
// ─────────────────────────────────────────────
router.post(
  '/paypal/capture-order',
  [
    body('orderID')
      .notEmpty()
      .withMessage('PayPal order ID is required'),
  ],
  validate,
  capturePayPalOrder
);

// ─────────────────────────────────────────────
// 👤 AUTH: MY DONATIONS
// ─────────────────────────────────────────────
router.get('/my', authenticate, getMyDonations);

// ─────────────────────────────────────────────
// 🧑‍💼 CREATOR: CAMPAIGN DONATIONS
// ─────────────────────────────────────────────
router.get(
  '/campaign/:id',
  authenticate,
  requireCreator,
  getCampaignDonations
);

// ─────────────────────────────────────────────
// 💰 CREATOR: PAYMENT METHOD
// ─────────────────────────────────────────────
router.get(
  '/creator/payment-method',
  authenticate,
  requireCreator,
  getCreatorPaymentMethod
);

router.put(
  '/creator/payment-method',
  authenticate,
  requireCreator,
  [
    body('paypal_email')
      .isEmail()
      .withMessage('Valid PayPal email is required'),
  ],
  validate,
  saveCreatorPaymentMethod
);

// ─────────────────────────────────────────────
// 🧠 FUTURE PROTECTION NOTE
// ─────────────────────────────────────────────
// Later we will add:
// - /paypal/webhook (IMPORTANT for production reliability)
// - idempotency middleware (prevent double charges)
// - wallet integration hooks

module.exports = router;