const router = require('express').Router()
const { requireAdmin } = require('../middleware/auth')
const { adminGetAllCampaigns, adminUpdateStatus } = require('../controllers/campaignController')
const { adminGetAllDonations } = require('../controllers/donationController')
const {
  getStats, getAllUsers, toggleUserActive,
  getDisputes, createDispute, resolveDispute,
  getTheme, saveTheme,
  getSettings, saveSettings,
  getContent, saveContent,
  sendMassMail,
  saveFCMToken,
} = require('../controllers/adminController')

// NOTE: authenticate runs once in server.js via app.use('/api/admin', authenticate, adminRoutes)
// So we only need requireAdmin here for role checking

// ── FCM token (any authenticated user, no admin required) ─────────
router.post('/fcm-token', saveFCMToken)

// ── All other routes require admin role ───────────────────────────
router.use(requireAdmin)

router.get('/stats',                  getStats)
router.get('/users',                  getAllUsers)
router.patch('/users/:id/toggle',     toggleUserActive)
router.get('/campaigns',              adminGetAllCampaigns)
router.patch('/campaigns/:id/status', adminUpdateStatus)
router.get('/donations',              adminGetAllDonations)
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

module.exports = router