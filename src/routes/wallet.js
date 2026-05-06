const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const upload = require('../middleware/upload');
const {
  getBalance,
  getTransactions,
  requestDeposit,
  getMyDepositRequests,
  uploadProof,
  donateFromWallet,
} = require('../controllers/walletController');

router.get('/balance', authenticate, getBalance);
router.get('/transactions', authenticate, getTransactions);
router.get('/deposit-requests', authenticate, getMyDepositRequests);
router.post('/deposit-request', authenticate, requestDeposit);
router.post('/deposit-request/:requestId/proof', authenticate, upload.single('proof'), uploadProof);
router.post('/donate', authenticate, donateFromWallet);

module.exports = router;