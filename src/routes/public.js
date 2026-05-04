const router = require('express').Router()
const pool = require('../config/db')

// GET /api/settings/public
router.get('/settings/public', async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('content', 'paypal_client_id')"
    )

    let socialLinks = {}
    let paypalClientId = null

    for (const row of result.rows) {
      if (row.key === 'content') {
        try {
          const content = JSON.parse(row.value)
          socialLinks = content.social_links || {}
        } catch (e) {
          // If parsing fails, ignore and leave empty
        }
      } else if (row.key === 'paypal_client_id') {
        paypalClientId = row.value
      }
    }

    res.json({
      social_links: socialLinks,
      paypal_client_id: paypalClientId || 'sb'   // fallback to sandbox
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router