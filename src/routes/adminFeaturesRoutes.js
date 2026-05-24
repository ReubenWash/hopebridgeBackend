// src/routes/adminFeaturesRoutes.js
const router = require('express').Router();
const { requireAdmin } = require('../middleware/auth');

// Import all controllers
const {
  // Payout Reconciliation
  getPayoutHistory,
  markAsPaid,
  getPayoutSummary,
  
  // Transaction Fee Management
  getFeeSettings,
  updateFeeSettings,
  calculateFee,
  
  // Notification System
  getNotificationSettings,
  updateNotificationSettings,
  sendNotification,
  getNotificationHistory,
  
  // Creator Verification
  getCreatorVerifications,
  reviewCreatorVerification,
  
  // Donor Management
  getTopDonors,
  getRecurringDonations,
  updateSubscriptionStatus,
  getDonorAnalytics,
  
  // Audit Logs
  getAuditLogs,
} = require('../controllers/adminFeaturesController');

// All routes require admin authentication
router.use(requireAdmin);

// ── Payout Reconciliation ──────────────────────────
router.get('/payouts', getPayoutHistory);
router.get('/payouts/summary', getPayoutSummary);
router.put('/payouts/:id/mark-paid', markAsPaid);

// ── Transaction Fee Management ────────────────────
router.get('/fees', getFeeSettings);
router.put('/fees', updateFeeSettings);
router.post('/fees/calculate', calculateFee);

// ── Creator Verification ──────────────────────────
router.get('/creator-verifications', getCreatorVerifications);
router.put('/creator-verifications/:id/review', reviewCreatorVerification);

// ── Donor Management ──────────────────────────────
router.get('/top-donors', getTopDonors);
router.get('/recurring-donations', getRecurringDonations);
router.put('/recurring-donations/:id/status', updateSubscriptionStatus);
router.get('/donor-analytics', getDonorAnalytics);

// ── Audit Logs ────────────────────────────────────
router.get('/audit-logs', getAuditLogs);

// ── Push Notifications ────────────────────────────
router.get('/notification-settings', getNotificationSettings);
router.put('/notification-settings', updateNotificationSettings);
router.post('/send-notification', sendNotification);
router.get('/notification-history', getNotificationHistory);

module.exports = router;