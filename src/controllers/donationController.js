const pool = require('../config/db');
const axios = require('axios');
const { sendDonationConfirmation, sendNewDonationAdminAlert } = require('../utils/email');

// ─────────────────────────────────────────────
// SETTINGS HELPER
// ─────────────────────────────────────────────
const getSetting = async (key) => {
  const res = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return res.rows[0]?.value || null;
};

// ─────────────────────────────────────────────
// PAYPAL ACCESS TOKEN
// ─────────────────────────────────────────────
const getPayPalAccessToken = async () => {
  const clientId = (await getSetting('paypal_client_id')) || process.env.PAYPAL_CLIENT_ID;
  const secret = (await getSetting('paypal_client_secret')) || process.env.PAYPAL_SECRET;
  const mode = (await getSetting('paypal_mode')) || process.env.PAYPAL_MODE || 'sandbox';

  if (!clientId || !secret) {
    throw new Error('PayPal credentials not configured. Please set them in admin settings.');
  }

  const baseURL =
    mode === 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';

  const auth = Buffer.from(`${clientId}:${secret}`).toString('base64');

  const response = await axios.post(
    `${baseURL}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  return { access_token: response.data.access_token, baseURL };
};

// ─────────────────────────────────────────────
// VERIFY PAYPAL ORDER
// ─────────────────────────────────────────────
const verifyPayPalOrder = async (orderId) => {
  const { access_token, baseURL } = await getPayPalAccessToken();
  const response = await axios.get(`${baseURL}/v2/checkout/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  return response.data;
};

// ─────────────────────────────────────────────
// CREATE PAYPAL ORDER
// ─────────────────────────────────────────────
const createPayPalOrder = async (req, res, next) => {
  try {
    const { campaign_id, amount, donor_name, donor_email, message, is_monthly } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Invalid donation amount.' });
    }

    const campRes = await pool.query(
      'SELECT id, title, status FROM campaigns WHERE id = $1',
      [campaign_id]
    );

    if (!campRes.rows.length) {
      return res.status(404).json({ error: 'Campaign not found.' });
    }
    if (campRes.rows[0].status !== 'approved') {
      return res.status(400).json({ error: 'Donations are only accepted for approved campaigns.' });
    }

    const { access_token, baseURL } = await getPayPalAccessToken();

    const order = await axios.post(
      `${baseURL}/v2/checkout/orders`,
      {
        intent: 'CAPTURE',
        purchase_units: [
          {
            amount: {
              currency_code: 'USD',
              value: Number(amount).toFixed(2),
            },
            description: `Donation to ${campRes.rows[0].title}`,
            custom_id: JSON.stringify({
              campaign_id,
              donor_name: donor_name || 'Anonymous',
              donor_email: donor_email || '',
              message: message || '',
              is_monthly: is_monthly || false,
            }),
          },
        ],
        application_context: {
          brand_name: 'HopeBridge',
          landing_page: 'NO_PREFERENCE',
          user_action: 'PAY_NOW',
        },
      },
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.json({ orderID: order.data.id });
  } catch (err) {
    console.error('PayPal order creation error:', err.response?.data || err.message);
    if (err.message.includes('credentials not configured')) {
      return res.status(503).json({ error: err.message });
    }
    next(err);
  }
};

// ─────────────────────────────────────────────
// CAPTURE PAYPAL ORDER
// ─────────────────────────────────────────────
const capturePayPalOrder = async (req, res, next) => {
  try {
    const { orderID } = req.body;
    if (!orderID) return res.status(400).json({ error: 'Order ID required.' });

    const orderData = await verifyPayPalOrder(orderID);

    // Capture the payment if not yet captured
    let captureData = orderData;
    if (orderData.status === 'APPROVED') {
      const { access_token, baseURL } = await getPayPalAccessToken();
      const captureRes = await axios.post(
        `${baseURL}/v2/checkout/orders/${orderID}/capture`,
        {},
        { headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' } }
      );
      captureData = captureRes.data;
    }

    if (captureData.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Payment not completed.' });
    }

    const purchaseUnit = captureData.purchase_units?.[0];
    const capture = purchaseUnit?.payments?.captures?.[0];
    if (!capture) return res.status(400).json({ error: 'Invalid PayPal data.' });

    const amount = Number(capture.amount.value);
    let custom = {};
    try {
      custom = JSON.parse(purchaseUnit.custom_id || '{}');
    } catch {
      return res.status(400).json({ error: 'Corrupted metadata.' });
    }

    const { campaign_id, donor_name, donor_email, message, is_monthly } = custom;
    if (!campaign_id) return res.status(400).json({ error: 'Missing campaign data.' });

    // Prevent duplicate
    const existing = await pool.query(
      'SELECT id FROM donations WHERE payment_reference = $1',
      [orderID]
    );
    if (existing.rows.length > 0) {
      return res.status(200).json({ message: 'Already processed.', alreadyProcessed: true });
    }

    const campRes = await pool.query('SELECT id, title FROM campaigns WHERE id = $1', [campaign_id]);
    if (!campRes.rows.length) return res.status(404).json({ error: 'Campaign not found.' });

    // Save donation
    const result = await pool.query(
      `INSERT INTO donations
       (campaign_id, donor_name, donor_email, amount, message, is_monthly, payment_method, payment_reference)
       VALUES ($1,$2,$3,$4,$5,$6,'paypal',$7)
       RETURNING *`,
      [
        campaign_id,
        donor_name || 'PayPal Donor',
        donor_email || '',
        amount,
        message || '',
        is_monthly || false,
        orderID,
      ]
    );

    // Update campaign raised
    await pool.query(
      `UPDATE campaigns
       SET raised = (SELECT COALESCE(SUM(amount),0) FROM donations WHERE campaign_id = $1)
       WHERE id = $1`,
      [campaign_id]
    );

    const donation = result.rows[0];

    // Admin notification
    const adminResult = await pool.query("SELECT email FROM users WHERE role = 'admin' LIMIT 1");
    if (adminResult.rows.length > 0) {
      sendNewDonationAdminAlert({
        adminEmail: adminResult.rows[0].email,
        donorName: donation.donor_name,
        amount: donation.amount,
        campaignTitle: campRes.rows[0].title,
        campaignId: campaign_id,
        paymentMethod: 'PayPal',
      }).catch(e => console.warn('Admin donation email failed:', e.message));
    }

    // Donor confirmation
    if (donation.donor_email) {
      sendDonationConfirmation({
        to: donation.donor_email,
        donorName: donation.donor_name,
        amount: donation.amount,
        campaignTitle: campRes.rows[0].title,
      }).catch(e => console.warn('Donor confirmation email failed:', e.message));
    }

    res.status(201).json({
      message: `Thank you ${donation.donor_name}! Your donation of $${amount} was received.`,
      donation,
    });
  } catch (err) {
    console.error('PayPal capture error:', err.response?.data || err.message);
    next(err);
  }
};

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
// CREATOR PAYMENT METHOD
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

// Stub for legacy route
const createDonation = (req, res) => {
  res.status(410).json({ error: 'Direct card payments are no longer supported. Please use PayPal or wallet.' });
};

module.exports = {
  createDonation,
  createPayPalOrder,
  capturePayPalOrder,
  getCampaignDonations,
  getMyDonations,
  getCreatorPaymentMethod,
  saveCreatorPaymentMethod,
  adminGetAllDonations,
};