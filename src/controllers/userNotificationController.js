const pool = require('../config/db');

// ── Get notifications for the authenticated user ──
const getUserNotifications = async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Temporary: return empty array until you create a real notifications table
    // Replace this with actual database query
    const result = await pool.query(
      `SELECT id, message, type, is_read as read, created_at as time
       FROM user_notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId]
    );

    const notifications = result.rows;
    const unreadResult = await pool.query(
      'SELECT COUNT(*) FROM user_notifications WHERE user_id = $1 AND is_read = false',
      [userId]
    );
    const unreadCount = parseInt(unreadResult.rows[0].count);

    res.json({ notifications, unread_count: unreadCount });
  } catch (err) {
    next(err);
  }
};

// ── Mark a single notification as read ──
const markNotificationRead = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    await pool.query(
      'UPDATE user_notifications SET is_read = true WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

// ── Mark all notifications as read ──
const markAllNotificationsRead = async (req, res, next) => {
  try {
    const userId = req.user.id;
    await pool.query(
      'UPDATE user_notifications SET is_read = true WHERE user_id = $1',
      [userId]
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getUserNotifications,
  markNotificationRead,
  markAllNotificationsRead,
};