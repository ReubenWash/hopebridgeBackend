const pool = require('../config/db');
const { sendPushNotification, sendToRole, sendToAll, sendToUser } = require('../config/firebase');

// Send notification to specific users
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
          return res.status(400).json({ error: 'target_user_id required for specific_user target' });
        }
        result = await sendToUser(target_user_id, notification, data || {});
        break;
      default:
        return res.status(400).json({ error: 'Invalid target_type' });
    }
    
    // Log notification to database
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
    next(err);
  }
};

// Get notification settings
const getNotificationSettings = async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('push_notifications_enabled', 'firebase_server_key', 'firebase_sender_id')"
    );
    const settings = {};
    result.rows.forEach(row => {
      settings[row.key] = row.value;
    });
    
    res.json({
      enabled: settings.push_notifications_enabled === 'true',
      server_key: settings.firebase_server_key || '',
      sender_id: settings.firebase_sender_id || '',
    });
  } catch (err) {
    next(err);
  }
};

// Update notification settings
const updateNotificationSettings = async (req, res, next) => {
  const { enabled, server_key, sender_id } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    await client.query(
      `INSERT INTO settings (key, value) VALUES 
        ('push_notifications_enabled', $1),
        ('firebase_server_key', $2),
        ('firebase_sender_id', $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [enabled ? 'true' : 'false', server_key || '', sender_id || '']
    );
    
    await client.query('COMMIT');
    res.json({ message: 'Notification settings updated', enabled });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

module.exports = {
  sendNotification,
  getNotificationHistory,
  getNotificationSettings,
  updateNotificationSettings,
};