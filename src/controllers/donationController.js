const pool = require('../config/db');
const { sendDonationConfirmation, sendNewDonationAdminAlert } = require('../utils/email');

// ─────────────────────────────────────────────
// GET CAMPAIGN DONATIONS (public for campaign profile)
// ─────────────────────────────────────────────
const getCampaignDonations = async (req, res, next) => {
  try {
    const { id } = req.params;

    // For public access (campaign profile), no auth check needed
    // But if user is authenticated and trying to access their own campaign, verify
    if (req.user && req.user.role !== 'admin') {
      const campCheck = await pool.query(
        'SELECT id FROM campaigns WHERE id = $1 AND creator_id = $2',
        [id, req.user.id]
      );
      if (campCheck.rows.length === 0 && req.user.role !== 'admin') {
        // User is not the creator and not admin, but we still return public donations
        // We don't block, just continue - donations are public info
      }
    }

    const result = await pool.query(
      `SELECT d.*, c.title AS campaign_title,
              u.name AS donor_name_from_user
       FROM donations d
       LEFT JOIN campaigns c ON d.campaign_id = c.id
       LEFT JOIN users u ON d.donor_id = u.id
       WHERE d.campaign_id = $1 AND d.payment_method = 'wallet'
       ORDER BY d.created_at DESC`,
      [id]
    );

    // Format donations with proper donor names
    const donations = result.rows.map(d => ({
      ...d,
      donor_name: d.donor_name || d.donor_name_from_user || 'Anonymous',
      amount: parseFloat(d.amount)
    }));

    const total = donations.reduce((sum, d) => sum + d.amount, 0);

    res.json({ donations, total });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────
// GET MY DONATIONS (donor)
// ─────────────────────────────────────────────
const getMyDonations = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT d.*, c.title AS campaign_title,
              c.status AS campaign_status
       FROM donations d
       LEFT JOIN campaigns c ON d.campaign_id = c.id
       WHERE d.donor_email = $1 OR d.donor_id = $2
       ORDER BY d.created_at DESC`,
      [req.user.email, req.user.id]
    );
    
    const donations = result.rows.map(d => ({
      ...d,
      amount: parseFloat(d.amount)
    }));
    
    res.json({ donations });
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
// CREATOR WALLET (balance and total earned)
// ─────────────────────────────────────────────
const getCreatorWallet = async (req, res, next) => {
  try {
    // Get wallet balance
    const walletRes = await pool.query(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [req.user.id]
    );
    
    // Get total earned from escrow releases
    const earnedRes = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total 
       FROM wallet_transactions 
       WHERE user_id = $1 AND type = 'escrow_release'`,
      [req.user.id]
    );
    
    res.json({
      balance: parseFloat(walletRes.rows[0]?.balance || 0),
      total_earned: parseFloat(earnedRes.rows[0]?.total || 0)
    });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────
// GET MY PAYOUT REQUESTS (withdrawals)
// ─────────────────────────────────────────────
const getMyPayoutRequests = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM withdrawal_requests 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ requests: result.rows });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────
// REQUEST PAYOUT (withdrawal)
// ─────────────────────────────────────────────
const requestPayout = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { amount, payment_method = 'bank', payment_details } = req.body;
    const withdrawAmount = parseFloat(amount);
    
    if (!withdrawAmount || withdrawAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    
    await client.query('BEGIN');
    
    // Check wallet balance
    const walletRes = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [req.user.id]
    );
    
    const balance = parseFloat(walletRes.rows[0]?.balance || 0);
    if (withdrawAmount > balance) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // Create withdrawal request (don't deduct balance yet - admin approves first)
    const result = await client.query(
      `INSERT INTO withdrawal_requests 
       (user_id, amount, payment_method, payment_details, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [req.user.id, withdrawAmount, payment_method, payment_details || '']
    );
    
    await client.query('COMMIT');
    
    // Notify admin (optional)
    const adminRes = await pool.query("SELECT email FROM users WHERE role = 'admin' LIMIT 1");
    if (adminRes.rows.length > 0) {
      console.log(`Admin notified: Withdrawal request #${result.rows[0].id} for $${withdrawAmount} from user ${req.user.id}`);
    }
    
    res.status(201).json({
      message: 'Withdrawal request submitted. Admin will review and process.',
      request: result.rows[0]
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────
// UPDATE CAMPAIGN PROGRESS (manual update for testing)
// ─────────────────────────────────────────────
const updateCampaignProgress = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { raised } = req.body;
    
    // Verify campaign belongs to creator
    const campCheck = await pool.query(
      'SELECT id, creator_id FROM campaigns WHERE id = $1',
      [id]
    );
    
    if (campCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    // Allow admin or creator to update
    if (campCheck.rows[0].creator_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to update this campaign' });
    }
    
    await pool.query(
      'UPDATE campaigns SET raised = $1 WHERE id = $2',
      [raised, id]
    );
    
    res.json({ message: 'Progress updated successfully' });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────
// ADMIN: GET ALL DONATIONS
// ─────────────────────────────────────────────
const adminGetAllDonations = async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT d.*, c.title AS campaign_title,
             u.name AS user_name
      FROM donations d
      LEFT JOIN campaigns c ON d.campaign_id = c.id
      LEFT JOIN users u ON d.donor_id = u.id
      ORDER BY d.created_at DESC
    `);
    
    const donations = result.rows.map(d => ({
      ...d,
      amount: parseFloat(d.amount)
    }));
    
    res.json({ donations });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────
// GET DONATION BY ID (for receipt/invoice)
// ─────────────────────────────────────────────
const getDonationById = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      `SELECT d.*, c.title AS campaign_title,
              c.creator_id, u.name AS creator_name
       FROM donations d
       LEFT JOIN campaigns c ON d.campaign_id = c.id
       LEFT JOIN users u ON c.creator_id = u.id
       WHERE d.id = $1`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Donation not found' });
    }
    
    // Check if user is authorized (donor, campaign creator, or admin)
    const donation = result.rows[0];
    if (req.user && 
        (req.user.id === donation.donor_id || 
         req.user.id === donation.creator_id || 
         req.user.role === 'admin')) {
      donation.amount = parseFloat(donation.amount);
      res.json({ donation });
    } else if (!req.user) {
      // For public, return limited info
      res.json({ 
        donation: {
          id: donation.id,
          donor_name: donation.donor_name || 'Anonymous',
          amount: parseFloat(donation.amount),
          campaign_title: donation.campaign_title,
          created_at: donation.created_at,
          is_monthly: donation.is_monthly
        }
      });
    } else {
      res.status(403).json({ error: 'Not authorized to view this donation' });
    }
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
  getDonationById,
  getCreatorWallet,
  getMyPayoutRequests,
  requestPayout,
  updateCampaignProgress,
};