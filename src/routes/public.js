const router = require('express').Router()
const pool = require('../config/db')

// GET /api/settings/public – returns public-safe settings (PayPal client ID, social links)
router.get('/settings/public', async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('content','paypal_client_id','paypal_mode')"
    )

    let socialLinks = {}
    let paypalClientId = process.env.PAYPAL_CLIENT_ID || null
    let paypalMode = process.env.PAYPAL_MODE || 'sandbox'

    for (const row of result.rows) {
      if (row.key === 'content') {
        try {
          const content = JSON.parse(row.value)
          socialLinks = content.social_links || {}
        } catch { /* ignore */ }
      } else if (row.key === 'paypal_client_id') {
        if (row.value && row.value.trim()) paypalClientId = row.value.trim()
      } else if (row.key === 'paypal_mode') {
        paypalMode = row.value
      }
    }

    res.json({
      social_links: socialLinks,
      paypal_client_id: paypalClientId || '',
      paypal_mode: paypalMode,
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router