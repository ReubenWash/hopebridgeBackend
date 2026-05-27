const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const {
  getUserNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} = require('../controllers/userNotificationController');

// All routes require authentication
router.use(authenticate);

router.get('/', getUserNotifications);
router.put('/:id/read', markNotificationRead);
router.put('/read-all', markAllNotificationsRead);

module.exports = router;