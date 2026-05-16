const router = require('express').Router();
const { body } = require('express-validator');

const {
  getCampaignDonations,
  getCreatorPaymentMethod,
  saveCreatorPaymentMethod,
  getMyDonations,
  getCreatorWallet,
  getMyPayoutRequests,
  requestPayout,
  updateCampaignProgress,
  getDonationById,
} = require('../controllers/donationController');

const { authenticate, requireCreator } = require('../middleware/auth');
const { validate } = require('../middleware/errorHandler');

// Auth required routes for donors
router.get('/my', authenticate, getMyDonations);

// Get single donation by ID (for receipt/invoice)
router.get('/:id', authenticate, getDonationById);

// Creator routes – view donations for their campaigns
router.get(
  '/campaign/:id',
  authenticate,
  requireCreator,
  getCampaignDonations
);

// Creator payment method (for withdrawals – bank details)
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
    body('account_name').optional().trim(),
    body('account_number').optional().trim(),
    body('bank_name').optional().trim(),
    body('paypal_email').optional().isEmail().withMessage('Valid PayPal email is required if using PayPal'),
  ],
  validate,
  saveCreatorPaymentMethod
);

// Creator wallet and payouts
router.get(
  '/creator/wallet',
  authenticate,
  requireCreator,
  getCreatorWallet
);

router.get(
  '/creator/payout-requests',
  authenticate,
  requireCreator,
  getMyPayoutRequests
);

router.post(
  '/creator/request-payout',
  authenticate,
  requireCreator,
  [
    body('amount').isFloat({ min: 1 }).withMessage('Amount must be at least $1'),
    body('payment_method').optional().isIn(['bank', 'paypal', 'mobile_money']).withMessage('Invalid payment method'),
    body('payment_details').optional().trim(),
  ],
  validate,
  requestPayout
);

// Update campaign progress (manual update for testing/emergency)
router.patch(
  '/campaigns/:id/progress',
  authenticate,
  requireCreator,
  [
    body('raised').isFloat({ min: 0 }).withMessage('Invalid raised amount'),
  ],
  validate,
  updateCampaignProgress
);

// All donation creation is now handled by wallet routes (with escrow)
// No PayPal or direct card endpoints remain

module.exports = router;