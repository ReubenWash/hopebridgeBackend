const pool = require('../config/db');
const { sendDonationConfirmation, sendNewDonationAdminAlert } = require('../utils/email');

// ─────────────────────────────────────────────
// GET CAMPAIGN DONATIONS (creator only)
// ─────────────────────────────────────────────
const getCampaignDonations = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Verify campaign belongs to creator (or admin)
    if (req.user.role !== 'admin') {
      const campCheck = await pool.query(
        'SELECT id FROM campaigns WHERE id = $1 AND creator_id = $2',
        [id, req.user.id]
      );
      if (campCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Not authorized to view these donations.' });
      }
    }

    const result = await pool.query(
      `SELECT d.*, c.title AS campaign_title
       FROM donations d
       LEFT JOIN campaigns c ON d.campaign_id = c.id
       WHERE d.campaign_id = $1
       ORDER BY d.created_at DESC`,
      [id]
    );

    const total = result.rows.reduce((sum, d) => sum + parseFloat(d.amount), 0);

    res.json({ donations: result.rows, total });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────
// GET MY DONATIONS (donor)
// ─────────────────────────────────────────────
const getMyDonations = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT d.*, c.title AS campaign_title
       FROM donations d
       LEFT JOIN campaigns c ON d.campaign_id = c.id
       WHERE d.donor_email = $1 OR d.donor_id = $2
       ORDER BY d.created_at DESC`,
      [req.user.email, req.user.id]
    );
    res.json({ donations: result.rows });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────
// CREATOR PAYMENT METHOD (for withdrawals)
// ─────────────────────────────────────────────
const getCreatorPaymentMethod = async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM creator_payment_methods WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ payment_method: result.rows[0] || {} });
  } catch (err) { next(err); }
};

const saveCreatorPaymentMethod = async (req, res, next) => {
  try {
    const { paypal_email, account_name, account_number, bank_name } = req.body;
    await pool.query(
      `INSERT INTO creator_payment_methods (user_id, paypal_email, account_name, account_number, bank_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id)
       DO UPDATE SET paypal_email = EXCLUDED.paypal_email,
                     account_name = EXCLUDED.account_name,
                     account_number = EXCLUDED.account_number,
                     bank_name = EXCLUDED.bank_name`,
      [req.user.id, paypal_email || null, account_name || null, account_number || null, bank_name || null]
    );
    res.json({ message: 'Payment method saved.' });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────
// ADMIN: GET ALL DONATIONS
// ─────────────────────────────────────────────
const adminGetAllDonations = async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT d.*, c.title AS campaign_title
      FROM donations d
      LEFT JOIN campaigns c ON d.campaign_id = c.id
      ORDER BY d.created_at DESC
    `);
    res.json({ donations: result.rows });
  } catch (err) { next(err); }
};

// Stub for legacy route – no longer used (only wallet donations)
const createDonation = (req, res) => {
  res.status(410).json({ error: 'Direct donations are no longer supported. Please use wallet funding and donate from your wallet.' });
};

module.exports = {
  createDonation,
  getCampaignDonations,
  getMyDonations,
  getCreatorPaymentMethod,
  saveCreatorPaymentMethod,
  adminGetAllDonations,
};