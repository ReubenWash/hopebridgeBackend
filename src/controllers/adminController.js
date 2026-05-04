const pool = require('../config/db');
const { sendMassEmail } = require('../utils/email');

// ── Stats ───────────────────────────────────────────────────────────
const getStats = async (req, res, next) => {
  try {
    const [campaigns, donations, users, disputes] = await Promise.all([
      pool.query(`SELECT
        COUNT(*) AS total_campaigns,
        COUNT(*) FILTER (WHERE status = 'pending')  AS pending_campaigns,
        COUNT(*) FILTER (WHERE status = 'approved') AS approved_campaigns
        FROM campaigns`),
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total_raised FROM donations`),
      pool.query(`SELECT COUNT(*) AS total_users FROM users`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'open') AS open_disputes FROM disputes`),
    ]);

    res.json({
      stats: {
        total_campaigns:    parseInt(campaigns.rows[0].total_campaigns),
        pending_campaigns:  parseInt(campaigns.rows[0].pending_campaigns),
        approved_campaigns: parseInt(campaigns.rows[0].approved_campaigns),
        total_raised:       parseFloat(donations.rows[0].total_raised),
        total_users:        parseInt(users.rows[0].total_users),
        open_disputes:      parseInt(disputes.rows[0].open_disputes),
      }
    });
  } catch (err) { next(err); }
};

// ── Users ───────────────────────────────────────────────────────────
const getAllUsers = async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, role, is_active, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ users: result.rows });
  } catch (err) { next(err); }
};

const toggleUserActive = async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE users SET is_active = NOT is_active WHERE id = $1 AND role != 'admin'
       RETURNING id, name, email, role, is_active`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found or cannot modify admin.' });
    }
    const user = result.rows[0];
    res.json({
      message: `User ${user.is_active ? 'activated' : 'deactivated'} successfully.`,
      user,
    });
  } catch (err) { next(err); }
};

// ── Disputes ────────────────────────────────────────────────────────
const getDisputes = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT d.*, c.title AS campaign_title, u.name AS reported_by_name
       FROM disputes d
       LEFT JOIN campaigns c ON d.campaign_id = c.id
       LEFT JOIN users u ON d.reported_by = u.id
       ORDER BY d.created_at DESC`
    );
    res.json({ disputes: result.rows });
  } catch (err) { next(err); }
};

const createDispute = async (req, res, next) => {
  try {
    const { type, description, campaign_id } = req.body;
    const result = await pool.query(
      `INSERT INTO disputes (type, description, campaign_id, reported_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [type, description, campaign_id || null, req.user.id]
    );
    res.status(201).json({ message: 'Dispute created.', dispute: result.rows[0] });
  } catch (err) { next(err); }
};

const resolveDispute = async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE disputes SET status = 'resolved' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Dispute not found.' });
    }
    res.json({ message: 'Dispute resolved.', dispute: result.rows[0] });
  } catch (err) { next(err); }
};

// ── Theme ───────────────────────────────────────────────────────────
const getTheme = async (req, res, next) => {
  try {
    const result = await pool.query("SELECT value FROM settings WHERE key = 'theme'");
    const theme = result.rows.length ? JSON.parse(result.rows[0].value) : {};
    res.json({ theme });
  } catch (err) { next(err); }
};

const saveTheme = async (req, res, next) => {
  try {
    const theme = req.body;
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('theme', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(theme)]
    );
    res.json({ message: 'Theme saved.' });
  } catch (err) { next(err); }
};

// ── Settings ────────────────────────────────────────────────────────
const getSettings = async (req, res, next) => {
  try {
    const result = await pool.query("SELECT key, value FROM settings");
    const settings = {};
    for (const row of result.rows) {
      if (row.key === 'theme') {
        settings.theme = JSON.parse(row.value);
      } else {
        if (!settings.keys) settings.keys = {};
        settings.keys[row.key] = row.value;
      }
    }
    res.json({ settings });
  } catch (err) { next(err); }
};

const saveSettings = async (req, res, next) => {
  try {
    const { theme, keys } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (theme) {
        await client.query(
          `INSERT INTO settings (key, value) VALUES ('theme', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [JSON.stringify(theme)]
        );
      }
      if (keys) {
        for (const [k, v] of Object.entries(keys)) {
          await client.query(
            `INSERT INTO settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [k, v]
          );
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
    res.json({ message: 'Settings saved.' });
  } catch (err) { next(err); }
};

// ── Content ─────────────────────────────────────────────────────────
const getContent = async (req, res, next) => {
  try {
    const result = await pool.query("SELECT value FROM settings WHERE key = 'content'");
    const content = result.rows.length ? JSON.parse(result.rows[0].value) : {};
    res.json({ content });
  } catch (err) { next(err); }
};

const saveContent = async (req, res, next) => {
  try {
    const content = req.body;
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('content', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(content)]
    );
    res.json({ message: 'Content saved.' });
  } catch (err) { next(err); }
};

// ── Mass Mail ────────────────────────────────────────────────────────
const sendMassMail = async (req, res, next) => {
  try {
    const { subject, message, recipient_type, campaign_id } = req.body;

    const smtpRes = await pool.query(
      "SELECT key, value FROM settings WHERE key = ANY($1)",
      [['smtp_host','smtp_port','smtp_user','smtp_pass']]
    );
    const smtp = {};
    for (const row of smtpRes.rows) smtp[row.key] = row.value;

    const transporter = {
      host: smtp.smtp_host || process.env.SMTP_HOST,
      port: parseInt(smtp.smtp_port || process.env.SMTP_PORT || 587),
      user: smtp.smtp_user || process.env.SMTP_USER,
      pass: smtp.smtp_pass || process.env.SMTP_PASS,
    };

    let recipients = [];
    if (recipient_type === 'all_donors') {
      const r = await pool.query("SELECT email FROM users WHERE role = 'donor'");
      recipients = r.rows.map(r => r.email);
    } else if (recipient_type === 'all_creators') {
      const r = await pool.query("SELECT email FROM users WHERE role = 'creator'");
      recipients = r.rows.map(r => r.email);
    } else if (recipient_type === 'all_users') {
      const r = await pool.query("SELECT email FROM users");
      recipients = r.rows.map(r => r.email);
    } else if (recipient_type === 'campaign_donors') {
      if (!campaign_id) throw new Error('campaign_id required');
      const r = await pool.query(
        "SELECT DISTINCT donor_email AS email FROM donations WHERE campaign_id = $1",
        [campaign_id]
      );
      recipients = r.rows.map(r => r.email);
    } else {
      return res.status(400).json({ error: 'Invalid recipient_type' });
    }

    await sendMassEmail({ transporter, to: recipients, subject, text: message });
    res.json({ message: `Emails sent to ${recipients.length} recipients.` });
  } catch (err) { next(err); }
};

// ── FCM Token ────────────────────────────────────────────────────────
const saveFCMToken = async (req, res, next) => {
  try {
    const { token } = req.body;
    const userId = req.user.id;
    await pool.query(
      `UPDATE users SET fcm_token = $1 WHERE id = $2`,
      [token, userId]
    );
    res.json({ message: 'FCM token saved.' });
  } catch (err) { next(err); }
};

module.exports = {
  getStats, getAllUsers, toggleUserActive,
  getDisputes, createDispute, resolveDispute,
  getTheme, saveTheme,
  getSettings, saveSettings,
  getContent, saveContent,
  sendMassMail, saveFCMToken,
};