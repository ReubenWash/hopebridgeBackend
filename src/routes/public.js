const router = require('express').Router()
const pool = require('../config/db')

// GET /api/settings/public – returns public-safe settings (social links, banner content, etc.)
router.get('/settings/public', async (req, res, next) => {
  try {
    // Only fetch content settings (social links, hero text, etc.) – 
    const result = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('content')"
    )

    let socialLinks = {}
    let heroTitle = ''
    let heroSubtitle = ''
    let impactStats = {}

    for (const row of result.rows) {
      if (row.key === 'content') {
        try {
          const content = JSON.parse(row.value)
          socialLinks = content.social_links || {}
          heroTitle = content.hero_title || ''
          heroSubtitle = content.hero_subtitle || ''
          impactStats = content.impact_stats || {}
        } catch (err) {
          console.warn('Failed to parse content settings:', err.message)
        }
      }
    }

    res.json({
      social_links: socialLinks,
      hero_title: heroTitle,
      hero_subtitle: heroSubtitle,
      impact_stats: impactStats,
    
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router