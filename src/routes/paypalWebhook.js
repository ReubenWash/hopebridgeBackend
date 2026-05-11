const router = require('express').Router();
const axios = require('axios');
const pool = require('../config/db');

// ─────────────────────────────────────────────
// SETTINGS HELPER
// ─────────────────────────────────────────────
const getSetting = async (key) => {
  const res = await pool.query(
    'SELECT value FROM settings WHERE key = $1',
    [key]
  );
  return res.rows[0]?.value || null;
};

// ─────────────────────────────────────────────
// GET PAYPAL ACCESS TOKEN
// ─────────────────────────────────────────────
const getPayPalAccessToken = async () => {
  const clientId = await getSetting('paypal_client_id');
  const secret = await getSetting('paypal_client_secret');
  const mode = (await getSetting('paypal_mode')) || 'sandbox';

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
// VERIFY PAYPAL WEBHOOK SIGNATURE (IMPORTANT)
// ─────────────────────────────────────────────
const verifyWebhook = async (req) => {
  const { access_token, baseURL } = await getPayPalAccessToken();

  const webhookId = await getSetting('paypal_webhook_id');

  const response = await axios.post(
    `${baseURL}/v1/notifications/verify-webhook-signature`,
    {
      auth_algo: req.headers['paypal-auth-algo'],
      cert_url: req.headers['paypal-cert-url'],
      transmission_id: req.headers['paypal-transmission-id'],
      transmission_sig: req.headers['paypal-transmission-sig'],
      transmission_time: req.headers['paypal-transmission-time'],
      webhook_id: webhookId,
      webhook_event: req.body,
    },
    {
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data.verification_status === 'SUCCESS';
};

// ─────────────────────────────────────────────
// WEBHOOK ENDPOINT
// ─────────────────────────────────────────────
router.post('/paypal', async (req, res) => {
  try {
    const event = req.body;

    // 🔐 STEP 1: VERIFY PAYPAL SENT THIS (CRITICAL)
    const isValid = await verifyWebhook(req);

    if (!isValid) {
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    // ─────────────────────────────────────────────
    // PAYMENT COMPLETED EVENT
    // ─────────────────────────────────────────────
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const capture = event.resource;

      const amount = capture.amount?.value;
      const customId = capture.custom_id;

      if (!customId) return res.status(200).send('No custom data');

      let data;
      try {
        data = JSON.parse(customId);
      } catch {
        return res.status(200).send('Bad metadata');
      }

      const {
        campaign_id,
        donor_name,
        donor_email,
        message,
        is_monthly,
      } = data;

      // 🔐 Prevent duplicates
      const exists = await pool.query(
        'SELECT id FROM donations WHERE payment_reference = $1',
        [capture.id]
      );

      if (exists.rows.length > 0) {
        return res.status(200).send('Already processed');
      }

      // ─────────────────────────────────────────────
      // SAVE DONATION (TRUST WEBHOOK ONLY)
      // ─────────────────────────────────────────────
      await pool.query(
        `
        INSERT INTO donations
        (campaign_id, donor_name, donor_email, amount, message, is_monthly, payment_method, payment_reference)
        VALUES ($1,$2,$3,$4,$5,$6,'paypal',$7)
        `,
        [
          campaign_id,
          donor_name || 'PayPal Donor',
          donor_email || '',
          amount,
          message || '',
          is_monthly || false,
          capture.id,
        ]
      );

      // ─────────────────────────────────────────────
      // UPDATE CAMPAIGN TOTAL
      // ─────────────────────────────────────────────
      await pool.query(
        `
        UPDATE campaigns
        SET raised = (
          SELECT COALESCE(SUM(amount),0)
          FROM donations
          WHERE campaign_id = $1
        )
        WHERE id = $1
        `,
        [campaign_id]
      );
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).send('Webhook error');
  }
});

module.exports = router;