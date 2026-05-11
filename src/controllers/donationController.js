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
  const clientId = await getSetting('paypal_client_id');
  const secret = await getSetting('paypal_client_secret');
  const mode = (await getSetting('paypal_mode')) || 'sandbox';

  if (!clientId || !secret) {
    throw new Error('PayPal credentials not configured');
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

  return {
    access_token: response.data.access_token,
    baseURL,
  };
};

// ─────────────────────────────────────────────
// PAYPAL VERIFY (SECURITY LAYER)
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

    if (!amount || amount <= 0) {
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
              donor_name,
              donor_email,
              message,
              is_monthly,
            }),
          },
        ],
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
    next(err);
  }
};

// ─────────────────────────────────────────────
// CAPTURE PAYMENT (WITH ADMIN EMAIL ALERT)
// ─────────────────────────────────────────────
const capturePayPalOrder = async (req, res, next) => {
  try {
    const { orderID } = req.body;
    if (!orderID) {
      return res.status(400).json({ error: 'Order ID required.' });
    }

    // 🔐 Verify with PayPal
    const orderData = await verifyPayPalOrder(orderID);
    if (orderData.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Payment not completed.' });
    }

    const purchaseUnit = orderData.purchase_units?.[0];
    const capture = purchaseUnit?.payments?.captures?.[0];
    if (!capture) {
      return res.status(400).json({ error: 'Invalid PayPal data.' });
    }

    const amount = Number(capture.amount.value);
    let custom = {};
    try {
      custom = JSON.parse(purchaseUnit.custom_id || '{}');
    } catch {
      return res.status(400).json({ error: 'Corrupted metadata.' });
    }

    const { campaign_id, donor_name, donor_email, message, is_monthly } = custom;
    if (!campaign_id) {
      return res.status(400).json({ error: 'Missing campaign data.' });
    }

    // 🔐 Prevent duplicate
    const existing = await pool.query(
      'SELECT id FROM donations WHERE payment_reference = $1',
      [orderID]
    );
    if (existing.rows.length > 0) {
      return res.status(200).json({ message: 'Already processed.' });
    }

    const campRes = await pool.query(
      'SELECT id, title FROM campaigns WHERE id = $1',
      [campaign_id]
    );
    if (!campRes.rows.length) {
      return res.status(404).json({ error: 'Campaign not found.' });
    }

    // Save donation
    const result = await pool.query(
      `INSERT INTO donations 
       (campaign_id, donor_name, donor_email, amount, message, is_monthly, payment_method, payment_reference)
       VALUES ($1,$2,$3,$4,$5,$6,'paypal',$7)
       RETURNING *`,
      [
        campaign_id,
        donor_name?.trim() || 'PayPal Donor',
        donor_email?.toLowerCase().trim() || '',
        amount,
        message || '',
        is_monthly || false,
        orderID,
      ]
    );

    // Update campaign raised amount
    await pool.query(
      `UPDATE campaigns
       SET raised = (SELECT COALESCE(SUM(amount),0) FROM donations WHERE campaign_id = $1)
       WHERE id = $1`,
      [campaign_id]
    );

    const donation = result.rows[0];

    // 🆕 Send admin email alert
    const adminResult = await pool.query("SELECT email FROM users WHERE role = 'admin' LIMIT 1");
    if (adminResult.rows.length > 0) {
      sendNewDonationAdminAlert({
        adminEmail: adminResult.rows[0].email,
        donorName: donation.donor_name,
        amount: donation.amount,
        campaignTitle: campRes.rows[0].title,
        campaignId: campaign_id,
        paymentMethod: 'PayPal',
      }).catch(e => console.warn('Admin email failed:', e.message));
    }

    // Send donor confirmation email (optional)
    if (donation.donor_email) {
      sendDonationConfirmation({
        to: donation.donor_email,
        donorName: donation.donor_name,
        amount: donation.amount,
        campaignTitle: campRes.rows[0].title,
      }).catch(e => console.warn('Donor confirmation email failed:', e.message));
    }

    res.status(201).json({
      message: `Thank you ${donation.donor_name}!`,
      donation,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// CREATOR PAYMENT METHODS
// ─────────────────────────────────────────────
const getCreatorPaymentMethod = async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT paypal_email FROM creator_payment_methods WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ payment_method: result.rows[0] || { paypal_email: '' } });
  } catch (err) {
    next(err);
  }
};

const saveCreatorPaymentMethod = async (req, res, next) => {
  try {
    const { paypal_email } = req.body;
    if (!paypal_email) {
      return res.status(400).json({ error: 'PayPal email required.' });
    }
    await pool.query(
      `INSERT INTO creator_payment_methods (user_id, paypal_email)
       VALUES ($1,$2)
       ON CONFLICT (user_id)
       DO UPDATE SET paypal_email = EXCLUDED.paypal_email`,
      [req.user.id, paypal_email]
    );
    res.json({ message: 'Saved.' });
  } catch (err) {
    next(err);
  }
};

// 🧾 Get my donations (for donor dashboard)
const getMyDonations = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT d.*, c.title AS campaign_title
       FROM donations d
       LEFT JOIN campaigns c ON d.campaign_id = c.id
       WHERE d.donor_email = $1
       ORDER BY d.created_at DESC`,
      [req.user.email]
    );
    res.json({ donations: result.rows });
  } catch (err) {
    next(err);
  }
};

// Admin: get all donations
const adminGetAllDonations = async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT d.*, c.title AS campaign_title, u.name AS donor_name
      FROM donations d
      LEFT JOIN campaigns c ON d.campaign_id = c.id
      LEFT JOIN users u ON d.donor_email = u.email
      ORDER BY d.created_at DESC
    `);
    res.json({ donations: result.rows });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────
module.exports = {
  createDonation: (req, res, next) => { /* keep as is, not used in PayPal flow but required by routes */ },
  createPayPalOrder,
  capturePayPalOrder,
  getCreatorPaymentMethod,
  saveCreatorPaymentMethod,
  getMyDonations,
  adminGetAllDonations,
};