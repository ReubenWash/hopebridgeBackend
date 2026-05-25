const router = require('express').Router()
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const { requireAdmin } = require('../middleware/auth')
const pool = require('../config/db')
const upload = require('../middleware/upload')

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
  adjustWalletBalance,
  getUserWalletDetails,
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
  createCampaign,
  updateCampaign,
  updateCampaignProgress,
  updateUser,
} = require('../controllers/adminFeaturesController')

// NOTE: authenticate runs once in server.js
router.post('/fcm-token', saveFCMToken)

// ============ EMERGENCY ADMIN LOGIN (WORKS DURING MAINTENANCE) ============
router.post('/emergency-login', async (req, res) => {
  try {
    const { email, password } = req.body
    
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password required' })
    }
    
    const result = await pool.query(
      `SELECT id, name, email, password, role, is_active as active 
       FROM users 
       WHERE email = $1 AND role = 'admin'`,
      [email]
    )
    
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' })
    }
    
    const user = result.rows[0]
    
    if (!user.active) {
      return res.status(401).json({ message: 'Account is disabled' })
    }
    
    const isPasswordValid = await bcrypt.compare(password, user.password)
    
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid credentials' })
    }
    
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'your-secret-key-change-this',
      { expiresIn: '24h' }
    )
    
    const userData = {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      active: user.active
    }
    
    res.json({
      success: true,
      token,
      user: userData,
      message: 'Emergency login successful'
    })
    
  } catch (error) {
    console.error('Emergency login error:', error)
    res.status(500).json({ message: 'Server error during emergency login: ' + error.message })
  }
})

// Apply admin authentication for all subsequent routes
router.use(requireAdmin)

// Stats & Users
router.get('/stats', getStats)
router.get('/users', getAllUsers)
router.patch('/users/:id/toggle', toggleUserActive)

// ============ USER MANAGEMENT ============
router.post('/users', addUser)
router.put('/users/:id', updateUser)
router.delete('/users/:id', deleteUser)
router.patch('/users/:id/verify', verifyUser)
router.patch('/users/:id/unverify', unverifyUser)
router.post('/change-password', changePassword)
router.post('/admins', addAdmin)

// Campaigns
router.get('/campaigns', adminGetAllCampaigns)
router.patch('/campaigns/:id/status', adminUpdateStatus)
router.get('/donations', adminGetAllDonations)

// ============ ADMIN CAMPAIGN MANAGEMENT ============
router.post('/campaigns/create', upload.single('image'), createCampaign)
router.put('/campaigns/:id', upload.single('image'), updateCampaign)
router.patch('/campaigns/:id/progress', updateCampaignProgress)

// Admin can get campaign by ID
router.get('/campaigns/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT c.*, u.name as creator_name, u.email as creator_email
       FROM campaigns c
       JOIN users u ON c.creator_id = u.id
       WHERE c.id = $1`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    res.json({ campaign: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ============ ADMIN WALLET MANAGEMENT ============
router.post('/wallet/adjust', adjustWalletBalance)
router.get('/wallet/user/:userId', getUserWalletDetails)

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

// ============ CONTENT MANAGEMENT (FIXED) ============
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

// ============ ESCROW & CAMPAIGN COMPLETION ============
// IMPORTANT: These MUST come before /campaigns/:id route
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

// ============ NOTIFICATION SETTINGS ============
router.get('/notification-settings', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT value FROM settings WHERE key = 'push_notifications_enabled'"
    );
    res.json({ enabled: result.rows[0]?.value === 'true' });
  } catch (err) {
    res.json({ enabled: true });
  }
});

router.put('/notification-settings', async (req, res) => {
  try {
    const { enabled } = req.body;
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('push_notifications_enabled', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [enabled ? 'true' : 'false']
    );
    res.json({ message: 'Settings updated', enabled });
  } catch (err) {
    next(err);
  }
});

module.exports = router;