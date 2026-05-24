// controllers/adminFeaturesController.js
const pool = require('../config/db');
const { sendPushNotification: sendFCMNotification, sendToRole, sendToAll, sendToUser } = require('../config/firebase');
const { uploadToImageKit, deleteFromImageKit } = require('../config/imagekit');

// ============ PAYOUT RECONCILIATION ============

const getPayoutHistory = async (req, res, next) => {
  try {
    const { startDate, endDate, status, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let conditions = [];
    let values = [];
    let paramCount = 1;
    
    if (startDate) {
      conditions.push(`wr.created_at >= $${paramCount++}`);
      values.push(startDate);
    }
    if (endDate) {
      conditions.push(`wr.created_at <= $${paramCount++}`);
      values.push(endDate);
    }
    if (status) {
      conditions.push(`wr.status = $${paramCount++}`);
      values.push(status);
    }
    
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    
    const result = await pool.query(`
      SELECT 
        wr.*,
        u.name as user_name,
        u.email as user_email,
        cp.account_name,
        cp.bank_name,
        cp.paypal_email
      FROM withdrawal_requests wr
      JOIN users u ON wr.user_id = u.id
      LEFT JOIN creator_payment_methods cp ON cp.user_id = u.id
      ${where}
      ORDER BY wr.created_at DESC
      LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `, [...values, parseInt(limit), offset]);
    
    const countResult = await pool.query(`
      SELECT COUNT(*) FROM withdrawal_requests wr ${where}
    `, values);
    
    const totals = await pool.query(`
      SELECT 
        COALESCE(SUM(amount), 0) as total_pending,
        COALESCE(SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END), 0) as total_approved,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as total_paid
      FROM withdrawal_requests
      ${where}
    `, values);
    
    res.json({
      payouts: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        pages: Math.ceil(parseInt(countResult.rows[0].count) / parseInt(limit))
      },
      totals: totals.rows[0]
    });
  } catch (err) { next(err); }
};

const markAsPaid = async (req, res, next) => {
  const { id } = req.params;
  const { transaction_id, notes } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const result = await client.query(`
      UPDATE withdrawal_requests 
      SET status = 'paid', 
          admin_note = COALESCE($1, admin_note),
          processed_at = NOW()
      WHERE id = $2 AND status = 'approved'
      RETURNING *
    `, [notes, id]);
    
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Withdrawal not found or not in approved state' });
    }
    
    await client.query(`
      INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, details, ip_address)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [req.user.id, 'withdrawal_marked_paid', 'withdrawal_request', id, JSON.stringify({ transaction_id, notes }), req.ip]);
    
    await client.query('COMMIT');
    
    res.json({ message: 'Withdrawal marked as paid', withdrawal: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

const getPayoutSummary = async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_withdrawals,
        COALESCE(SUM(amount), 0) as total_amount,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as pending_amount,
        COALESCE(SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END), 0) as approved_amount,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as paid_amount,
        COALESCE(SUM(CASE WHEN status = 'rejected' THEN amount ELSE 0 END), 0) as rejected_amount
      FROM withdrawal_requests
    `);
    
    const monthly = await pool.query(`
      SELECT 
        DATE_TRUNC('month', created_at) as month,
        COUNT(*) as count,
        COALESCE(SUM(amount), 0) as total
      FROM withdrawal_requests
      WHERE status = 'paid'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month DESC
      LIMIT 12
    `);
    
    res.json({
      summary: result.rows[0],
      monthly: monthly.rows
    });
  } catch (err) { next(err); }
};

// ============ TRANSACTION FEE MANAGEMENT ============

const getFeeSettings = async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT * FROM platform_fees ORDER BY id DESC LIMIT 1`);
    
    if (result.rows.length === 0) {
      return res.json({
        percentage: 0,
        fixed_amount: 0,
        min_fee: 0,
        max_fee: null,
        withdrawal_fee: 0,
        minimum_withdrawal: 10,
        minimum_deposit: 1,
        maximum_deposit: null
      });
    }
    
    res.json(result.rows[0]);
  } catch (err) { next(err); }
};

const updateFeeSettings = async (req, res, next) => {
  const { percentage, fixed_amount, min_fee, max_fee, withdrawal_fee, minimum_withdrawal, minimum_deposit, maximum_deposit } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const result = await client.query(`
      INSERT INTO platform_fees (percentage, fixed_amount, min_fee, max_fee, withdrawal_fee, minimum_withdrawal, minimum_deposit, maximum_deposit, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      percentage || 0, 
      fixed_amount || 0, 
      min_fee || 0, 
      max_fee || null, 
      withdrawal_fee || 0, 
      minimum_withdrawal || 10,
      minimum_deposit || 1,
      maximum_deposit || null,
      req.user.id
    ]);
    
    await client.query(`
      INSERT INTO audit_logs (admin_id, action, entity_type, details, ip_address)
      VALUES ($1, $2, $3, $4, $5)
    `, [req.user.id, 'fee_settings_updated', 'platform_fees', JSON.stringify(req.body), req.ip]);
    
    await client.query('COMMIT');
    
    res.json({ message: 'Fee settings updated', settings: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

const calculateFee = async (req, res, next) => {
  try {
    const { amount } = req.body;
    const feeSettings = await pool.query(`SELECT * FROM platform_fees ORDER BY id DESC LIMIT 1`);
    const fees = feeSettings.rows[0] || { percentage: 0, fixed_amount: 0, min_fee: 0, max_fee: null };
    
    let fee = (amount * (fees.percentage / 100)) + fees.fixed_amount;
    
    if (fees.min_fee && fee < fees.min_fee) fee = fees.min_fee;
    if (fees.max_fee && fee > fees.max_fee) fee = fees.max_fee;
    
    res.json({
      original_amount: amount,
      fee: parseFloat(fee.toFixed(2)),
      net_amount: parseFloat((amount - fee).toFixed(2)),
      settings: fees
    });
  } catch (err) { next(err); }
};

// ============ NOTIFICATION SYSTEM MANAGEMENT ============

const getNotificationSettings = async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('push_notifications_enabled', 'firebase_server_key', 'firebase_sender_id')"
    );
    const settings = {};
    result.rows.forEach(row => { settings[row.key] = row.value; });
    
    res.json({
      enabled: settings.push_notifications_enabled === 'true',
      server_key: settings.firebase_server_key || '',
      sender_id: settings.firebase_sender_id || ''
    });
  } catch (err) { next(err); }
};

const updateNotificationSettings = async (req, res, next) => {
  const { enabled, server_key, sender_id } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    await client.query(`
      INSERT INTO settings (key, value) VALUES 
        ('push_notifications_enabled', $1),
        ('firebase_server_key', $2),
        ('firebase_sender_id', $3)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [enabled ? 'true' : 'false', server_key || '', sender_id || '']);
    
    await client.query('COMMIT');
    res.json({ message: 'Notification settings updated', enabled });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// Send notification using modern Firebase Admin SDK
const sendNotification = async (req, res, next) => {
  try {
    const { title, body, target_type, target_user_id, data, image_url } = req.body;
    
    if (!title || !body) {
      return res.status(400).json({ error: 'Title and body are required' });
    }
    
    const settings = await pool.query(
      "SELECT value FROM settings WHERE key = 'push_notifications_enabled'"
    );
    const enabled = settings.rows[0]?.value === 'true';
    
    if (!enabled) {
      return res.status(400).json({ error: 'Push notifications are disabled' });
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
        return res.status(400).json({ error: 'Invalid target_type. Use: all, donors, creators, admins, specific_user' });
    }
    
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
    console.error('Send notification error:', err);
    next(err);
  }
};

const getNotificationHistory = async (req, res, next) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    const result = await pool.query(`
      SELECT * FROM push_notifications 
      ORDER BY sent_at DESC 
      LIMIT $1 OFFSET $2
    `, [parseInt(limit), offset]);
    
    const countResult = await pool.query('SELECT COUNT(*) FROM push_notifications');
    
    res.json({
      notifications: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        pages: Math.ceil(parseInt(countResult.rows[0].count) / parseInt(limit))
      }
    });
  } catch (err) { 
    if (err.message.includes('does not exist')) {
      res.json({ notifications: [], pagination: { total: 0, pages: 0 } });
    } else {
      next(err);
    }
  }
};

// ============ ADMIN CAMPAIGN MANAGEMENT (NEW) ============

const createCampaign = async (req, res, next) => {
  try {
    const { title, description, goal, category, creator_name } = req.body;
    
    if (!title || !goal) {
      return res.status(400).json({ error: 'Title and goal are required' });
    }
    
    let creatorId = req.user.id;
    if (creator_name) {
      const creatorResult = await pool.query(
        "SELECT id FROM users WHERE name ILIKE $1 OR email ILIKE $1 AND role = 'creator' LIMIT 1",
        [`%${creator_name}%`]
      );
      if (creatorResult.rows.length > 0) {
        creatorId = creatorResult.rows[0].id;
      }
    }
    
    let image_url = null;
    let image_file_id = null;
    
    if (req.file) {
      try {
        const uploadResult = await uploadToImageKit(req.file.buffer, `${Date.now()}-campaign.jpg`, 'hopebridge/campaigns');
        if (uploadResult.url) {
          image_url = uploadResult.url;
          image_file_id = uploadResult.fileId;
        }
      } catch (err) {
        console.warn('Image upload failed:', err.message);
      }
    }
    
    const result = await pool.query(
      `INSERT INTO campaigns (creator_id, title, description, goal, image_url, image_file_id, category, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved')
       RETURNING *`,
      [creatorId, title.trim(), description?.trim() || null, parseFloat(goal), image_url, image_file_id, category || 'General']
    );
    
    await pool.query(`
      INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, details, ip_address)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [req.user.id, 'admin_campaign_created', 'campaign', result.rows[0].id, JSON.stringify({ title, creator_id: creatorId }), req.ip]);
    
    res.status(201).json({
      message: `Campaign "${title}" created successfully`,
      campaign: result.rows[0]
    });
  } catch (err) { next(err); }
};

const updateCampaign = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, goal, category, status } = req.body;
    
    const existing = await pool.query('SELECT * FROM campaigns WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (title !== undefined) {
      updates.push(`title = $${paramCount++}`);
      values.push(title.trim());
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description?.trim() || null);
    }
    if (goal !== undefined) {
      updates.push(`goal = $${paramCount++}`);
      values.push(parseFloat(goal));
    }
    if (category !== undefined) {
      updates.push(`category = $${paramCount++}`);
      values.push(category);
    }
    if (status !== undefined) {
      updates.push(`status = $${paramCount++}`);
      values.push(status);
    }
    
    if (req.file) {
      const oldImageId = existing.rows[0].image_file_id;
      try {
        const uploadResult = await uploadToImageKit(req.file.buffer, `${Date.now()}-campaign.jpg`, 'hopebridge/campaigns');
        if (uploadResult.url) {
          updates.push(`image_url = $${paramCount++}`);
          values.push(uploadResult.url);
          updates.push(`image_file_id = $${paramCount++}`);
          values.push(uploadResult.fileId);
          if (oldImageId) await deleteFromImageKit(oldImageId).catch(console.warn);
        }
      } catch (err) {
        console.warn('Image upload failed:', err.message);
      }
    } else if (req.body.image_url !== undefined) {
      updates.push(`image_url = $${paramCount++}`);
      values.push(req.body.image_url || null);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    values.push(id);
    const query = `UPDATE campaigns SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramCount} RETURNING *`;
    const result = await pool.query(query, values);
    
    await pool.query(`
      INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, details, ip_address)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [req.user.id, 'admin_campaign_updated', 'campaign', id, JSON.stringify(req.body), req.ip]);
    
    res.json({ message: 'Campaign updated successfully', campaign: result.rows[0] });
  } catch (err) { next(err); }
};

const updateCampaignProgress = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { raised } = req.body;
    
    if (raised === undefined || parseFloat(raised) < 0) {
      return res.status(400).json({ error: 'Valid raised amount is required' });
    }
    
    const result = await pool.query(
      `UPDATE campaigns SET raised = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [parseFloat(raised), id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    await pool.query(`
      INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, details, ip_address)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [req.user.id, 'campaign_progress_updated', 'campaign', id, JSON.stringify({ new_raised: parseFloat(raised) }), req.ip]);
    
    res.json({ message: 'Progress updated', campaign: result.rows[0] });
  } catch (err) { next(err); }
};

// ============ ADMIN USER MANAGEMENT (NEW) ============

const updateUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, email, role, is_verified } = req.body;
    
    const userCheck = await pool.query('SELECT role FROM users WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (userCheck.rows[0].role === 'admin' && req.user.id !== parseInt(id)) {
      return res.status(403).json({ error: 'Cannot modify another admin account' });
    }
    
    const result = await pool.query(
      `UPDATE users SET 
        name = COALESCE($1, name), 
        email = COALESCE($2, email), 
        role = COALESCE($3, role), 
        is_verified = COALESCE($4, is_verified), 
        updated_at = NOW()
       WHERE id = $5
       RETURNING id, name, email, role, is_verified, is_active`,
      [name, email, role, is_verified, id]
    );
    
    await pool.query(`
      INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, details, ip_address)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [req.user.id, 'user_updated', 'user', id, JSON.stringify({ name, email, role, is_verified }), req.ip]);
    
    res.json({ message: 'User updated successfully', user: result.rows[0] });
  } catch (err) { next(err); }
};

// ============ ADMIN WALLET ADJUSTMENT (NEW) ============

const adjustWallet = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { userId, amount, type, reason } = req.body;
    
    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid user ID and amount required' });
    }
    
    const adjustmentAmount = type === 'add' ? parseFloat(amount) : -parseFloat(amount);
    
    await client.query('BEGIN');
    
    const userCheck = await client.query('SELECT name, email FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    
    await client.query(
      `INSERT INTO wallets (user_id, balance) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + $2`,
      [userId, adjustmentAmount]
    );
    
    await client.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, reference, description)
       VALUES ($1, $2, 'admin_adjustment', $3, $4)`,
      [userId, adjustmentAmount, `ADMIN-${Date.now()}`, reason || `Manual ${type === 'add' ? 'credit' : 'debit'} by admin`]
    );
    
    await client.query(`
      INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, details, ip_address)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [req.user.id, 'wallet_adjustment', 'wallet', userId, JSON.stringify({ amount, type, reason, user: userCheck.rows[0] }), req.ip]);
    
    const newBalance = await client.query('SELECT balance FROM wallets WHERE user_id = $1', [userId]);
    
    await client.query('COMMIT');
    
    res.json({ 
      message: `Wallet ${type === 'add' ? 'credited' : 'debited'} by $${Math.abs(adjustmentAmount)}`,
      newBalance: parseFloat(newBalance.rows[0]?.balance || 0)
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ============ CREATOR ONBOARDING/VERIFICATION ============

const getCreatorVerifications = async (req, res, next) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT cv.*, u.name, u.email, u.created_at as user_created_at
      FROM creator_verifications cv
      JOIN users u ON cv.user_id = u.id
    `;
    const values = [];
    
    if (status) {
      query += ` WHERE cv.status = $1`;
      values.push(status);
    }
    
    query += ` ORDER BY cv.created_at DESC`;
    
    const result = await pool.query(query, values);
    res.json({ verifications: result.rows });
  } catch (err) { next(err); }
};

const submitCreatorVerification = async (req, res, next) => {
  try {
    const { id_document_url, id_document_type, proof_of_address_url, business_registration_url } = req.body;
    
    const existing = await pool.query(
      'SELECT * FROM creator_verifications WHERE user_id = $1',
      [req.user.id]
    );
    
    let result;
    if (existing.rows.length > 0) {
      result = await pool.query(`
        UPDATE creator_verifications 
        SET id_document_url = COALESCE($1, id_document_url),
            id_document_type = COALESCE($2, id_document_type),
            proof_of_address_url = COALESCE($3, proof_of_address_url),
            business_registration_url = COALESCE($4, business_registration_url),
            status = 'pending',
            updated_at = NOW()
        WHERE user_id = $5
        RETURNING *
      `, [id_document_url, id_document_type, proof_of_address_url, business_registration_url, req.user.id]);
    } else {
      result = await pool.query(`
        INSERT INTO creator_verifications (user_id, id_document_url, id_document_type, proof_of_address_url, business_registration_url, status)
        VALUES ($1, $2, $3, $4, $5, 'pending')
        RETURNING *
      `, [req.user.id, id_document_url, id_document_type, proof_of_address_url, business_registration_url]);
    }
    
    res.json({ message: 'Verification submitted successfully', verification: result.rows[0] });
  } catch (err) { next(err); }
};

const reviewCreatorVerification = async (req, res, next) => {
  const { id } = req.params;
  const { status, notes } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const result = await client.query(`
      UPDATE creator_verifications 
      SET status = $1, 
          notes = $2, 
          reviewed_by = $3, 
          reviewed_at = NOW()
      WHERE id = $4
      RETURNING *
    `, [status, notes, req.user.id, id]);
    
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Verification not found' });
    }
    
    if (status === 'approved') {
      await client.query(`
        UPDATE users SET role = 'creator' WHERE id = $1
      `, [result.rows[0].user_id]);
    }
    
    await client.query(`
      INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, details, ip_address)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [req.user.id, `creator_verification_${status}`, 'creator_verifications', id, JSON.stringify({ notes }), req.ip]);
    
    await client.query('COMMIT');
    
    res.json({ message: `Verification ${status}`, verification: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ============ DONOR MANAGEMENT ============

const getTopDonors = async (req, res, next) => {
  try {
    const { limit = 10, timeframe } = req.query;
    
    let dateCondition = '';
    if (timeframe === 'month') {
      dateCondition = `AND d.created_at >= DATE_TRUNC('month', NOW())`;
    } else if (timeframe === 'year') {
      dateCondition = `AND d.created_at >= DATE_TRUNC('year', NOW())`;
    }
    
    const result = await pool.query(`
      SELECT 
        u.id,
        u.name,
        u.email,
        COALESCE(SUM(d.amount), 0) as total_donated,
        COUNT(d.id) as donation_count,
        MAX(d.created_at) as last_donation_date
      FROM users u
      LEFT JOIN donations d ON d.donor_id = u.id AND d.escrow_status = 'released' ${dateCondition}
      WHERE u.role = 'donor'
      GROUP BY u.id
      HAVING COALESCE(SUM(d.amount), 0) > 0
      ORDER BY total_donated DESC
      LIMIT $1
    `, [parseInt(limit)]);
    
    res.json({ donors: result.rows });
  } catch (err) { next(err); }
};

const getRecurringDonations = async (req, res, next) => {
  try {
    const { status = 'active' } = req.query;
    
    const result = await pool.query(`
      SELECT 
        ds.*,
        u.name as donor_name,
        u.email as donor_email,
        c.title as campaign_title
      FROM donor_subscriptions ds
      JOIN users u ON ds.donor_id = u.id
      LEFT JOIN campaigns c ON ds.campaign_id = c.id
      WHERE ds.status = $1
      ORDER BY ds.next_billing_date ASC NULLS LAST
    `, [status]);
    
    const totals = await pool.query(`
      SELECT 
        COUNT(*) as total_subscriptions,
        COALESCE(SUM(amount), 0) as monthly_recurring
      FROM donor_subscriptions
      WHERE status = 'active'
    `);
    
    res.json({ 
      subscriptions: result.rows,
      totals: totals.rows[0]
    });
  } catch (err) { next(err); }
};

const updateSubscriptionStatus = async (req, res, next) => {
  const { id } = req.params;
  const { status } = req.body;
  
  try {
    const result = await pool.query(`
      UPDATE donor_subscriptions 
      SET status = $1,
          cancelled_at = CASE WHEN $1 = 'cancelled' THEN NOW() ELSE cancelled_at END
      WHERE id = $2
      RETURNING *
    `, [status, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    
    res.json({ message: `Subscription ${status}`, subscription: result.rows[0] });
  } catch (err) { next(err); }
};

const getDonorAnalytics = async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(DISTINCT donor_id) as total_donors,
        COUNT(DISTINCT CASE WHEN d.created_at >= DATE_TRUNC('month', NOW()) THEN donor_id END) as new_donors_month,
        COUNT(DISTINCT CASE WHEN d.created_at >= DATE_TRUNC('week', NOW()) THEN donor_id END) as active_donors_week,
        COALESCE(AVG(daily.amount), 0) as avg_daily_donation
      FROM donations d
      CROSS JOIN (
        SELECT COALESCE(SUM(amount), 0) as amount, DATE(created_at) as date
        FROM donations
        WHERE created_at >= DATE_TRUNC('month', NOW())
        GROUP BY DATE(created_at)
      ) daily
      WHERE d.escrow_status = 'released'
    `);
    
    const retention = await pool.query(`
      WITH donor_activity AS (
        SELECT 
          donor_id,
          COUNT(*) as donation_count,
          MIN(created_at) as first_donation,
          MAX(created_at) as last_donation
        FROM donations
        WHERE escrow_status = 'released'
        GROUP BY donor_id
      )
      SELECT 
        COUNT(*) as total_donors,
        COUNT(CASE WHEN donation_count > 1 THEN 1 END) as returning_donors,
        COUNT(CASE WHEN last_donation >= DATE_TRUNC('month', NOW()) THEN 1 END) as active_this_month
      FROM donor_activity
    `);
    
    res.json({
      analytics: result.rows[0],
      retention: retention.rows[0]
    });
  } catch (err) { next(err); }
};

const getAuditLogs = async (req, res, next) => {
  try {
    const { action, admin_id, startDate, endDate, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let conditions = [];
    let values = [];
    let paramCount = 1;
    
    if (action) {
      conditions.push(`action = $${paramCount++}`);
      values.push(action);
    }
    if (admin_id) {
      conditions.push(`admin_id = $${paramCount++}`);
      values.push(admin_id);
    }
    if (startDate) {
      conditions.push(`created_at >= $${paramCount++}`);
      values.push(startDate);
    }
    if (endDate) {
      conditions.push(`created_at <= $${paramCount++}`);
      values.push(endDate);
    }
    
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    
    const result = await pool.query(`
      SELECT al.*, u.name as admin_name
      FROM audit_logs al
      LEFT JOIN users u ON al.admin_id = u.id
      ${where}
      ORDER BY created_at DESC
      LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `, [...values, parseInt(limit), offset]);
    
    const countResult = await pool.query(`SELECT COUNT(*) FROM audit_logs ${where}`, values);
    
    res.json({
      logs: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        pages: Math.ceil(parseInt(countResult.rows[0].count) / parseInt(limit))
      }
    });
  } catch (err) { next(err); }
};

module.exports = {
  // Payout Reconciliation
  getPayoutHistory,
  markAsPaid,
  getPayoutSummary,
  
  // Transaction Fee Management
  getFeeSettings,
  updateFeeSettings,
  calculateFee,
  
  // Notification System
  getNotificationSettings,
  updateNotificationSettings,
  sendNotification,
  getNotificationHistory,
  
  // Admin Campaign Management
  createCampaign,
  updateCampaign,
  updateCampaignProgress,
  
  // Admin User Management
  updateUser,
  
  // Admin Wallet Adjustment
  adjustWallet,
  
  // Creator Verification
  getCreatorVerifications,
  submitCreatorVerification,
  reviewCreatorVerification,
  
  // Donor Management
  getTopDonors,
  getRecurringDonations,
  updateSubscriptionStatus,
  getDonorAnalytics,
  
  // Audit Logs
  getAuditLogs,
};