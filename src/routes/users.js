const router = require('express').Router();
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const bcrypt = require('bcryptjs');

// ─────────────────────────────────────────────
// PUBLIC: GET user by ID (for campaign creator display)
// ─────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT id, name, email, role, created_at, is_active, is_verified FROM users WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = result.rows[0];
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────
// AUTHENTICATED: Get current user profile
// ─────────────────────────────────────────────
router.get('/me/profile', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, role, is_active, is_verified, created_at, notification_settings FROM users WHERE id = $1',
      [req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = result.rows[0];
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────
// AUTHENTICATED: Update user profile
// ─────────────────────────────────────────────
router.put('/me/profile', authenticate, async (req, res, next) => {
  try {
    const { name } = req.body;
    
    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'Name is required' });
    }
    
    const result = await pool.query(
      'UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, email, role',
      [name.trim(), req.user.id]
    );
    
    res.json({ 
      message: 'Profile updated successfully',
      user: result.rows[0]
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────
// AUTHENTICATED: Change password
// ─────────────────────────────────────────────
router.put('/me/password', authenticate, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }
    
    if (new_password.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    
    // Get current user with password
    const userResult = await pool.query(
      'SELECT password FROM users WHERE id = $1',
      [req.user.id]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Verify current password
    const isValid = await bcrypt.compare(current_password, userResult.rows[0].password);
    if (!isValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    
    // Hash new password
    const hashedPassword = await bcrypt.hash(new_password, 10);
    
    // Update password
    await pool.query(
      'UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2',
      [hashedPassword, req.user.id]
    );
    
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────
// AUTHENTICATED: Get notification settings
// ─────────────────────────────────────────────
router.get('/me/notifications', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT notification_settings FROM users WHERE id = $1',
      [req.user.id]
    );
    
    let settings = {
      email_notifications: true,
      donation_alerts: true,
      campaign_updates: true,
      marketing_emails: false
    };
    
    if (result.rows[0]?.notification_settings) {
      // Merge with defaults
      const savedSettings = result.rows[0].notification_settings;
      settings = { ...settings, ...savedSettings };
    }
    
    res.json({ settings });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────
// AUTHENTICATED: Update notification settings
// ─────────────────────────────────────────────
router.put('/me/notifications', authenticate, async (req, res, next) => {
  try {
    const { email_notifications, donation_alerts, campaign_updates, marketing_emails } = req.body;
    
    const settings = {
      email_notifications: email_notifications !== undefined ? email_notifications : true,
      donation_alerts: donation_alerts !== undefined ? donation_alerts : true,
      campaign_updates: campaign_updates !== undefined ? campaign_updates : true,
      marketing_emails: marketing_emails !== undefined ? marketing_emails : false
    };
    
    await pool.query(
      `UPDATE users 
       SET notification_settings = $1, updated_at = NOW() 
       WHERE id = $2`,
      [settings, req.user.id]
    );
    
    res.json({ 
      message: 'Notification settings updated successfully',
      settings 
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────
// AUTHENTICATED: Delete account (request)
// ─────────────────────────────────────────────
router.delete('/me/account', authenticate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Check if user has active campaigns
    const campaignCheck = await client.query(
      'SELECT COUNT(*) FROM campaigns WHERE creator_id = $1 AND status != \'completed\'',
      [req.user.id]
    );
    
    if (parseInt(campaignCheck.rows[0].count) > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: 'Cannot delete account with active campaigns. Please complete or archive them first.' 
      });
    }
    
    // Soft delete - deactivate account instead of hard delete
    await client.query(
      'UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1',
      [req.user.id]
    );
    
    await client.query('COMMIT');
    
    res.json({ message: 'Account deactivated successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// AUTHENTICATED: Get user statistics
// ─────────────────────────────────────────────
router.get('/me/stats', authenticate, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const role = req.user.role;
    
    let stats = {};
    
    if (role === 'donor') {
      // Donor stats
      const donationStats = await pool.query(`
        SELECT 
          COUNT(*) as total_donations,
          COALESCE(SUM(amount), 0) as total_amount,
          COUNT(DISTINCT campaign_id) as campaigns_supported
        FROM donations 
        WHERE donor_id = $1 AND status = 'completed'
      `, [userId]);
      
      stats = donationStats.rows[0];
    } else if (role === 'creator') {
      // Creator stats
      const campaignStats = await pool.query(`
        SELECT 
          COUNT(*) as total_campaigns,
          COALESCE(SUM(raised), 0) as total_raised,
          COUNT(CASE WHEN status = 'approved' THEN 1 END) as active_campaigns
        FROM campaigns 
        WHERE creator_id = $1
      `, [userId]);
      
      const donationStats = await pool.query(`
        SELECT 
          COUNT(*) as total_donations,
          COALESCE(SUM(amount), 0) as total_amount
        FROM donations d
        JOIN campaigns c ON d.campaign_id = c.id
        WHERE c.creator_id = $1 AND d.status = 'completed'
      `, [userId]);
      
      stats = {
        ...campaignStats.rows[0],
        total_donations: donationStats.rows[0].total_donations || 0,
        total_donated_amount: donationStats.rows[0].total_amount || 0
      };
    }
    
    res.json({ stats });
  } catch (err) {
    next(err);
  }
});

module.exports = router;