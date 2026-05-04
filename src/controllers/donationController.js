const pool   = require('../config/db');
const axios  = require('axios');
const { sendDonationConfirmation } = require('../utils/email');

// ── Helper: get a setting value from the settings table ─────────────
const getSetting = async (key) => {
  const res = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  if (res.rows.length === 0) return null;
  return res.rows[0].value;
};

// ── Helper: get PayPal access token ─────────────────────────────────
const getPayPalAccessToken = async () => {
  const clientId = await getSetting('paypal_client_id');
  const secret   = await getSetting('paypal_client_secret');
  const mode     = (await getSetting('paypal_mode')) || 'sandbox';   // sandbox / live

  if (!clientId || !secret) {
    throw new Error('PayPal credentials not configured');
  }

  const baseURL = mode === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

  const auth = Buffer.from(`${clientId}:${secret}`).toString('base64');
  const response = await axios.post(
    `${baseURL}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );
  return { access_token: response.data.access_token, baseURL };
};

// ── PayPal order creation (used by frontend donation form) ──────────
const createPayPalOrder = async (req, res, next) => {
  try {
    const { campaign_id, amount, donor_name, donor_email, message, is_monthly } = req.body;

    // Verify campaign
    const campRes = await pool.query(
      "SELECT id, title, status FROM campaigns WHERE id = $1",
      [campaign_id]
    );
    if (campRes.rows.length === 0) return res.status(404).json({ error: 'Campaign not found.' });
    if (campRes.rows[0].status !== 'approved') {
      return res.status(400).json({ error: 'Donations are only accepted for approved campaigns.' });
    }

    // Get PayPal access token and base URL
    const { access_token, baseURL } = await getPayPalAccessToken();

    // Create order
    const order = await axios.post(
      `${baseURL}/v2/checkout/orders`,
      {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: 'USD',
            value: parseFloat(amount).toFixed(2)
          },
          description: `Donation to ${campRes.rows[0].title}`,
          custom_id: JSON.stringify({ campaign_id, donor_name, donor_email, message, is_monthly })
        }]
      },
      {
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({ orderID: order.data.id });
  } catch (err) { next(err); }
};

// ── PayPal order capture (triggered after buyer approves) ───────────
const capturePayPalOrder = async (req, res, next) => {
  try {
    const { orderID } = req.body;
    if (!orderID) return res.status(400).json({ error: 'Order ID is required.' });

    // Get PayPal access token and base URL
    const { access_token, baseURL } = await getPayPalAccessToken();

    // Capture payment
    const captureResponse = await axios.post(
      `${baseURL}/v2/checkout/orders/${orderID}/capture`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const captureData = captureResponse.data;
    if (captureData.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Payment not completed.' });
    }

    // Extract donation details from the custom_id of the purchase unit
    const purchaseUnit = captureData.purchase_units[0];
    const customString = purchaseUnit.payments?.captures?.[0]?.custom ||
                         purchaseUnit.custom_id ||
                         '{}';
    let custom;
    try {
      custom = JSON.parse(customString);
    } catch {
      return res.status(400).json({ error: 'Order metadata corrupted.' });
    }

    const { campaign_id, donor_name, donor_email, message, is_monthly } = custom;
    const amount = purchaseUnit.amount.value;

    // Verify campaign again (just to be safe)
    const campRes = await pool.query(
      "SELECT id, title, status FROM campaigns WHERE id = $1",
      [campaign_id]
    );
    if (campRes.rows.length === 0) return res.status(404).json({ error: 'Campaign not found.' });

    // Insert donation record
    const result = await pool.query(`
      INSERT INTO donations (campaign_id, donor_name, donor_email, amount, message, is_monthly, payment_method)
      VALUES ($1, $2, $3, $4, $5, $6, 'paypal')
      RETURNING *
    `, [
      campaign_id,
      donor_name?.trim() || 'PayPal Donor',
      donor_email?.toLowerCase().trim() || '',
      parseFloat(amount),
      message || '',
      is_monthly || false
    ]);

    // Update campaign raised amount
    await pool.query(`
      UPDATE campaigns
      SET raised = (SELECT COALESCE(SUM(amount), 0) FROM donations WHERE campaign_id = $1)
      WHERE id = $1
    `, [campaign_id]);

    const donation = result.rows[0];

    // Send confirmation email
    sendDonationConfirmation({
      to:             donation.donor_email,
      donorName:      donation.donor_name,
      amount:         donation.amount,
      campaignTitle:  campRes.rows[0].title,
    }).catch(e => console.warn('Donation email failed:', e.message));

    res.status(201).json({
      message: `Thank you, ${donation.donor_name}! Your PayPal donation of $${donation.amount} was received.`,
      donation,
    });
  } catch (err) { next(err); }
};

// ── Creator payment methods ─────────────────────────────────────────
const getCreatorPaymentMethod = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      'SELECT paypal_email FROM creator_payment_methods WHERE user_id = $1',
      [userId]
    );
    const paymentMethod = result.rows[0] || { paypal_email: '' };
    res.json({ payment_method: paymentMethod });
  } catch (err) { next(err); }
};

const saveCreatorPaymentMethod = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { paypal_email } = req.body;

    if (!paypal_email) return res.status(400).json({ error: 'PayPal email is required.' });

    // Upsert
    await pool.query(`
      INSERT INTO creator_payment_methods (user_id, paypal_email)
      VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE SET paypal_email = EXCLUDED.paypal_email
    `, [userId, paypal_email]);

    res.json({ message: 'Payment method saved.' });
  } catch (err) { next(err); }
};

// ── Original functions (unchanged) ──────────────────────────────────
// POST /api/donations
const createDonation = async (req, res, next) => {
  try {
    const { campaign_id, donor_name, donor_email, amount, message = '', is_monthly = false } = req.body;

    const campRes = await pool.query(
      "SELECT id, title, status FROM campaigns WHERE id = $1",
      [campaign_id]
    );
    if (campRes.rows.length === 0) return res.status(404).json({ error: 'Campaign not found.' });
    if (campRes.rows[0].status !== 'approved') {
      return res.status(400).json({ error: 'Donations are only accepted for approved campaigns.' });
    }

    const campaign = campRes.rows[0];

    const result = await pool.query(`
      INSERT INTO donations (campaign_id, donor_name, donor_email, amount, message, is_monthly)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [campaign_id, donor_name.trim(), donor_email.toLowerCase().trim(), parseFloat(amount), message, is_monthly]);

    await pool.query(`
      UPDATE campaigns
      SET raised = (SELECT COALESCE(SUM(amount), 0) FROM donations WHERE campaign_id = $1)
      WHERE id = $1
    `, [campaign_id]);

    const donation = result.rows[0];

    sendDonationConfirmation({
      to:             donation.donor_email,
      donorName:      donation.donor_name,
      amount:         donation.amount,
      campaignTitle:  campaign.title,
    }).catch(e => console.warn('Donation email failed:', e.message));

    res.status(201).json({
      message: `Thank you, ${donation.donor_name}! Your donation of $${donation.amount} was received.`,
      donation,
    });
  } catch (err) { next(err); }
};

// GET /api/donations/campaign/:id
const getCampaignDonations = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (req.user.role === 'creator') {
      const ownership = await pool.query(
        'SELECT id FROM campaigns WHERE id = $1 AND creator_id = $2',
        [id, req.user.id]
      );
      if (ownership.rows.length === 0) {
        return res.status(403).json({ error: 'Access denied.' });
      }
    }

    const result = await pool.query(`
      SELECT d.*, c.title AS campaign_title
      FROM donations d
      JOIN campaigns c ON d.campaign_id = c.id
      WHERE d.campaign_id = $1
      ORDER BY d.created_at DESC
    `, [id]);

    const total = result.rows.reduce((sum, d) => sum + parseFloat(d.amount), 0);
    res.json({ donations: result.rows, total });
  } catch (err) { next(err); }
};

// GET /api/admin/donations
const adminGetAllDonations = async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT d.*, c.title AS campaign_title
      FROM donations d
      JOIN campaigns c ON d.campaign_id = c.id
      ORDER BY d.created_at DESC
      LIMIT 100
    `);
    const total = result.rows.reduce((sum, d) => sum + parseFloat(d.amount), 0);
    res.json({ donations: result.rows, total });
  } catch (err) { next(err); }
};

module.exports = {
  createDonation,
  getCampaignDonations,
  adminGetAllDonations,
  createPayPalOrder,
  capturePayPalOrder,
  getCreatorPaymentMethod,
  saveCreatorPaymentMethod,
};