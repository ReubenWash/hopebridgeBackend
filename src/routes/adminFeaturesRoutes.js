// routes/adminFeaturesRoutes.js
const router = require('express').Router();
const { requireAdmin, authenticate } = require('../middleware/auth');
const {
  // Payout
  getPayoutHistory,
  markAsPaid,
  getPayoutSummary,
  
  // Fees
  getFeeSettings,
  updateFeeSettings,
  calculateFee,
  
  // Notifications
  getNotificationSettings,
  updateNotificationSettings,
  sendPushNotification,
  getNotificationHistory,
  
  // Creator Verification
  getCreatorVerifications,
  submitCreatorVerification,
  reviewCreatorVerification,
  
  // Donor Management
  getTopDonors,
  getRecurringDonations,
  updateSubscriptionStatus,
  getDonorAnalytics,
  
  // Audit Logs
  getAuditLogs,
} = require('../controllers/adminFeaturesController');

// All routes require authentication
router.use(authenticate);

// ============ Payout Reconciliation ============
router.get('/payouts', requireAdmin, getPayoutHistory);
router.get('/payouts/summary', requireAdmin, getPayoutSummary);
router.put('/payouts/:id/mark-paid', requireAdmin, markAsPaid);

// ============ Transaction Fees ============
router.get('/fees', requireAdmin, getFeeSettings);
router.put('/fees', requireAdmin, updateFeeSettings);
router.post('/fees/calculate', requireAdmin, calculateFee);

// ============ Push Notifications ============
router.get('/notification-settings', requireAdmin, getNotificationSettings);
router.put('/notification-settings', requireAdmin, updateNotificationSettings);
router.post('/notifications/send', requireAdmin, sendPushNotification);
router.get('/notifications/history', requireAdmin, getNotificationHistory);

// ============ Creator Verification (Creators submit, Admins review) ============
router.get('/creator-verifications', requireAdmin, getCreatorVerifications);
router.post('/creator-verifications/submit', authenticate, submitCreatorVerification);
router.put('/creator-verifications/:id/review', requireAdmin, reviewCreatorVerification);

// ============ Donor Management ============
router.get('/top-donors', requireAdmin, getTopDonors);
router.get('/recurring-donations', requireAdmin, getRecurringDonations);
router.put('/recurring-donations/:id/status', requireAdmin, updateSubscriptionStatus);
router.get('/donor-analytics', requireAdmin, getDonorAnalytics);

// ============ Audit Logs ============
router.get('/audit-logs', requireAdmin, getAuditLogs);

module.exports = router;