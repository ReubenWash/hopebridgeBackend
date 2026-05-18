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

// NOTE: authenticate runs once in server.js via app.use('/api/admin', authenticate, adminRoutes)
// So we only need requireAdmin here for role checking

// ── FCM token (any authenticated user, no admin required) ─────────
router.post('/fcm-token', saveFCMToken)

// ── All other routes require admin role ───────────────────────────
router.use(requireAdmin)

// ── Stats & Users ──────────────────────────────────────────────────
router.get('/stats',                  getStats)
router.get('/users',                  getAllUsers)
router.patch('/users/:id/toggle',     toggleUserActive)

// ── Campaigns ──────────────────────────────────────────────────────
router.get('/campaigns',              adminGetAllCampaigns)
router.patch('/campaigns/:id/status', adminUpdateStatus)
router.get('/donations',              adminGetAllDonations)

// ── Disputes ───────────────────────────────────────────────────────
router.get('/disputes',               getDisputes)
router.post('/disputes',              createDispute)
router.patch('/disputes/:id/resolve', resolveDispute)

// ── Theme ──────────────────────────────────────────────────────────
router.get('/theme',                  getTheme)
router.put('/theme',                  saveTheme)

// ── Settings ───────────────────────────────────────────────────────
router.get('/settings',               getSettings)
router.put('/settings',               saveSettings)

// ── Content ────────────────────────────────────────────────────────
router.get('/content',                getContent)
router.put('/content',                saveContent)

// ── Mass Mail ──────────────────────────────────────────────────────
router.post('/mass-mail',             sendMassMail)

// ── Email Verification Settings ────────────────────────────────────
router.get('/verification-setting',   getVerificationSetting)
router.put('/verification-setting',   updateVerificationSetting)

// ── Firebase Push Notifications ────────────────────────────────────
router.post('/admin-fcm-token',       saveAdminFCMToken)
router.get('/admin-fcm-tokens',       getAdminFCMTokens)
router.delete('/admin-fcm-token',     removeAdminFCMToken)
router.get('/firebase-settings',      getFirebaseSettings)
router.put('/firebase-settings',      saveFirebaseSettings)
router.post('/test-push',             sendTestPushNotification)

// ── ImageKit.io Settings ───────────────────────────────────────────
router.get('/imagekit-settings',      getImageKitSettings)
router.put('/imagekit-settings',      saveImageKitSettings)

// ── Wallet & Deposit Requests (Admin) ──────────────────────────────
router.get('/deposit-requests',       getAllDepositRequests)
router.put('/deposit-requests/:id',   updateDepositRequest)

// ── Withdrawal Requests (Admin) ───────────────────────────────────
router.get('/withdrawal-requests',    getAllWithdrawalRequests)
router.put('/withdrawal-requests/:id/approve', approveWithdrawal)
router.put('/withdrawal-requests/:id/reject',  rejectWithdrawal)

// ── Escrow & Campaign Completion (Admin) ──────────────────────────
router.get('/campaigns/completion-requests',   getCompletionRequests)
router.post('/campaigns/:id/release-escrow',   adminReleaseCampaignEscrow)
router.post('/campaigns/:id/refund-escrow',    adminRefundCampaignEscrow)

module.exports = router