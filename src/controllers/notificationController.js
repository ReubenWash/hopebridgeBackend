const pool = require('../config/db');
const { sendPushNotification, sendToRole, sendToAll, sendToUser } = require('../config/firebase');

// Save FCM token for a user
const saveFCMToken = async (req, res, next) => {
  try {
    const { token } = req.body;
    const userId = req.user.id;
    
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }
    
    await pool.query(
      `UPDATE users SET fcm_token = $1, updated_at = NOW() WHERE id = $2`,
      [token, userId]
    );
    
    console.log(`✅ FCM token saved for user ${userId}`);
    res.json({ message: 'FCM token saved successfully' });
  } catch (err) {
    next(err);
  }
};

// Send notification
const sendNotification = async (req, res, next) => {
  try {
    const { title, body, target_type, target_user_id, data, image_url } = req.body;
    
    if (!title || !body) {
      return res.status(400).json({ error: 'Title and body are required' });
    }
    
    const notification = { title, body, imageUrl: image_url };
    let result;
    
    switch (target_type) {
      case 'all':
        result = await sendToAll(notification, data || {});
        break;
      case 'donors':
        result = await sendToRole('donor', notification, data || {});
        break;
      case 'creators':
        result = await sendToRole('creator', notification, data || {});
        break;
      case 'admins':
        result = await sendToRole('admin', notification, data || {});
        break;
      case 'specific_user':
        if (!target_user_id) {
          return res.status(400).json({ error: 'target_user_id required' });
        }
        result = await sendToUser(target_user_id, notification, data || {});
        break;
      default:
        return res.status(400).json({ error: 'Invalid target_type' });
    }
    
    // Log to database
    await pool.query(
      `INSERT INTO push_notifications (title, body, target_type, target_user_id, sent_count, delivered_count)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [title, body, target_type, target_user_id || null, result.successCount || 0, result.successCount || 0]
    );
    
    res.json({
      message: `Notification sent to ${result.successCount || 0} devices`,
      success: result.successCount,
      failure: result.failureCount,
    });
  } catch (err) {
    next(err);
  }
};

// Get notification history
const getNotificationHistory = async (req, res, next) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    const result = await pool.query(
      `SELECT * FROM push_notifications 
       ORDER BY sent_at DESC 
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), offset]
    );
    
    const countResult = await pool.query('SELECT COUNT(*) FROM push_notifications');
    
    res.json({
      notifications: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        pages: Math.ceil(parseInt(countResult.rows[0].count) / parseInt(limit)),
      },
    });
  } catch (err) {
    // Return empty array if table doesn't exist yet
    if (err.message.includes('does not exist')) {
      res.json({ notifications: [], pagination: { total: 0, pages: 0 } });
    } else {
      next(err);
    }
  }
};

// Get notification settings
const getNotificationSettings = async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('push_notifications_enabled', 'firebase_server_key')"
    );
    const settings = {};
    result.rows.forEach(row => {
      settings[row.key] = row.value;
    });
    
    res.json({
      enabled: settings.push_notifications_enabled === 'true',
      server_key: settings.firebase_server_key || '',
    });
  } catch (err) {
    // Return default settings if table doesn't exist
    res.json({ enabled: true, server_key: '' });
  }
};

// Update notification settings
const updateNotificationSettings = async (req, res, next) => {
  try {
    const { enabled, server_key } = req.body;
    
    await pool.query(
      `INSERT INTO settings (key, value) VALUES 
        ('push_notifications_enabled', $1),
        ('firebase_server_key', $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [enabled ? 'true' : 'false', server_key || '']
    );
    
    res.json({ message: 'Notification settings updated', enabled });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  saveFCMToken,
  sendNotification,
  getNotificationHistory,
  getNotificationSettings,
  updateNotificationSettings,
};