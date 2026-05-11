const express = require('express');
const router = express.Router();

const {
  requestWithdrawal,
  getMyWithdrawals,
  getAllWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
} = require('../controllers/withdrawalController');

const { protect, admin } = require('../middleware/authMiddleware');

// USER
router.post('/', protect, requestWithdrawal);
router.get('/me', protect, getMyWithdrawals);

// ADMIN
router.get('/', protect, admin, getAllWithdrawals);
router.put('/:id/approve', protect, admin, approveWithdrawal);
router.put('/:id/reject', protect, admin, rejectWithdrawal);

module.exports = router;