const router = require('express').Router();
const { body } = require('express-validator');

const {
  createDonation,
  createPayPalOrder,
  capturePayPalOrder,
  getCampaignDonations,
  getCreatorPaymentMethod,
  saveCreatorPaymentMethod,
  getMyDonations,
} = require('../controllers/donationController');

const { authenticate, requireCreator } = require('../middleware/auth');
const { validate } = require('../middleware/errorHandler');

// PayPal – public (no auth required for guest donations)
router.post(
  '/paypal/create-order',
  [
    body('campaign_id').isInt({ min: 1 }).withMessage('Valid campaign ID is required'),
    body('amount').isFloat({ min: 1 }).withMessage('Amount must be at least $1'),
    body('donor_name').optional().trim(),
    body('donor_email').optional().isEmail().normalizeEmail(),
    body('message').optional().trim(),
    body('is_monthly').optional().isBoolean(),
  ],
  validate,
  createPayPalOrder
);

router.post(
  '/paypal/capture-order',
  [body('orderID').notEmpty().withMessage('PayPal order ID is required')],
  validate,
  capturePayPalOrder
);

// Auth required routes
router.get('/my', authenticate, getMyDonations);

router.get(
  '/campaign/:id',
  authenticate,
  requireCreator,
  getCampaignDonations
);

// Creator payment method
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
    body('paypal_email').optional().isEmail().withMessage('Valid PayPal email is required'),
  ],
  validate,
  saveCreatorPaymentMethod
);

// Legacy card donation stub
router.post('/', createDonation);

module.exports = router;