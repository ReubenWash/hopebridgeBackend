const router = require('express').Router();
const { requireAdmin } = require('../middleware/auth');
const {
  sendNotification,
  getNotificationHistory,
  getNotificationSettings,
  updateNotificationSettings,
} = require('../controllers/notificationController');

// All notification routes require admin authentication
router.use(requireAdmin);

router.post('/send', sendNotification);
router.get('/history', getNotificationHistory);
router.get('/settings', getNotificationSettings);
router.put('/settings', updateNotificationSettings);

module.exports = router;