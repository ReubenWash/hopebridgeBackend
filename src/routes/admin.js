const router = require('express').Router()
const { requireAdmin } = require('../middleware/auth')
const {
  adminGetAllCampaigns,
  adminUpdateStatus,
  getCompletionRequests,
  adminReleaseCampaignEscrow,
  adminRefundCampaignEscrow,
} = require('../controllers/campaignController')
const { adminGetAllDonations } = require('../controllers/donationController')
const {
  getStats, getAllUsers, toggleUserActive,
  addUser, deleteUser, verifyUser, unverifyUser,
  changePassword, addAdmin,
  getDisputes, createDispute, resolveDispute,
  getTheme, saveTheme,
  getSettings, saveSettings,
  getContent, saveContent,
  sendMassMail,
  saveFCMToken,
  getVerificationSetting,
  updateVerificationSetting,
  saveAdminFCMToken,
  getAdminFCMTokens,
  removeAdminFCMToken,
  getFirebaseSettings,
  saveFirebaseSettings,
  getImageKitSettings,
  saveImageKitSettings,
  sendTestPushNotification,
} = require('../controllers/adminController')
const {
  getAllDepositRequests,
  updateDepositRequest,
  getAllWithdrawalRequests,
  approveWithdrawal,
  rejectWithdrawal,
} = require('../controllers/adminWalletController')
const {
  getPayoutHistory,
  markAsPaid,
  getPayoutSummary,
  getFeeSettings,
  updateFeeSettings,
  calculateFee,
  getCreatorVerifications,
  reviewCreatorVerification,
  getTopDonors,
  getRecurringDonations,
  updateSubscriptionStatus,
  getDonorAnalytics,
  getAuditLogs,
} = require('../controllers/adminFeaturesController')

// NOTE: authenticate runs once in server.js
router.post('/fcm-token', saveFCMToken)
router.use(requireAdmin)

// Stats & Users
router.get('/stats', getStats)
router.get('/users', getAllUsers)
router.patch('/users/:id/toggle', toggleUserActive)

// ============ USER MANAGEMENT (NEW) ============
router.post('/users', addUser)                                    // Add new user
router.delete('/users/:id', deleteUser)                          // Delete user
router.patch('/users/:id/verify', verifyUser)                    // Verify user
router.patch('/users/:id/unverify', unverifyUser)                // Unverify user
router.post('/change-password', changePassword)                  // Change admin password
router.post('/admins', addAdmin)                                 // Add new admin

// Campaigns
router.get('/campaigns', adminGetAllCampaigns)
router.patch('/campaigns/:id/status', adminUpdateStatus)
router.get('/donations', adminGetAllDonations)

// Disputes
router.get('/disputes', getDisputes)
router.post('/disputes', createDispute)
router.patch('/disputes/:id/resolve', resolveDispute)

// Theme
router.get('/theme', getTheme)
router.put('/theme', saveTheme)

// Settings
router.get('/settings', getSettings)
router.put('/settings', saveSettings)

// Content
router.get('/content', getContent)
router.put('/content', saveContent)

// Mass Mail
router.post('/mass-mail', sendMassMail)

// Email Verification
router.get('/verification-setting', getVerificationSetting)
router.put('/verification-setting', updateVerificationSetting)

// Firebase Push Notifications
router.post('/admin-fcm-token', saveAdminFCMToken)
router.get('/admin-fcm-tokens', getAdminFCMTokens)
router.delete('/admin-fcm-token', removeAdminFCMToken)
router.get('/firebase-settings', getFirebaseSettings)
router.put('/firebase-settings', saveFirebaseSettings)
router.post('/test-push', sendTestPushNotification)

// ImageKit.io
router.get('/imagekit-settings', getImageKitSettings)
router.put('/imagekit-settings', saveImageKitSettings)

// Deposit Requests
router.get('/deposit-requests', getAllDepositRequests)
router.put('/deposit-requests/:id', updateDepositRequest)

// Withdrawal Requests
router.get('/withdrawal-requests', getAllWithdrawalRequests)
router.put('/withdrawal-requests/:id/approve', approveWithdrawal)
router.put('/withdrawal-requests/:id/reject', rejectWithdrawal)

// Escrow & Campaign Completion
router.get('/campaigns/completion-requests', getCompletionRequests)
router.post('/campaigns/:id/release-escrow', adminReleaseCampaignEscrow)
router.post('/campaigns/:id/refund-escrow', adminRefundCampaignEscrow)

// ============ NEW FEATURES ============

// Payout Reconciliation
router.get('/payouts', getPayoutHistory)
router.get('/payouts/summary', getPayoutSummary)
router.put('/payouts/:id/mark-paid', markAsPaid)

// Transaction Fee Management
router.get('/fees', getFeeSettings)
router.put('/fees', updateFeeSettings)
router.post('/fees/calculate', calculateFee)

// Creator Verification
router.get('/creator-verifications', getCreatorVerifications)
router.put('/creator-verifications/:id/review', reviewCreatorVerification)

// Donor Management
router.get('/top-donors', getTopDonors)
router.get('/recurring-donations', getRecurringDonations)
router.put('/recurring-donations/:id/status', updateSubscriptionStatus)
router.get('/donor-analytics', getDonorAnalytics)

// Audit Logs
router.get('/audit-logs', getAuditLogs)

module.exports = router