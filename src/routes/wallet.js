const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const upload = require('../middleware/upload');
const {
  getBalance,
  getTransactions,
  requestDeposit,
  getMyDepositRequests,
  uploadProof,
  donateFromWallet,
  requestWithdrawal,
  getMyWithdrawals,
  getWalletSummary,
} = require('../controllers/walletController');

// All wallet routes require authentication
router.use(authenticate);

// Balance & summary
router.get('/balance',     getBalance);
router.get('/transactions', getTransactions);
router.get('/summary',     getWalletSummary);

// Deposit requests
router.get('/deposit-requests',  getMyDepositRequests);
router.post('/deposit-request',  requestDeposit);
router.post(
  '/deposit-request/:requestId/proof',
  upload.single('proof'),
  uploadProof
);

// Donate from wallet
router.post('/donate', donateFromWallet);

// Withdrawal
router.post('/withdrawal', requestWithdrawal);
router.get('/withdrawals', getMyWithdrawals);

module.exports = router;