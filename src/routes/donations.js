const router = require('express').Router();
const { body } = require('express-validator');

const {
  getCampaignDonations,
  getCreatorPaymentMethod,
  saveCreatorPaymentMethod,
  getMyDonations,
} = require('../controllers/donationController');

const { authenticate, requireCreator } = require('../middleware/auth');
const { validate } = require('../middleware/errorHandler');

// Auth required routes for donors
router.get('/my', authenticate, getMyDonations);

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

// All donation creation is now handled by wallet routes (with optional escrow for wallet)
// No PayPal or direct card endpoints remain

module.exports = router;