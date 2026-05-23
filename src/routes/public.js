const router = require('express').Router()
const pool = require('../config/db')

// GET /api/settings/public – returns public-safe settings (social links, banner content, etc.)
router.get('/settings/public', async (req, res, next) => {
  try {
    // Fetch content settings
    const result = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('content')"
    )

    let socialLinks = {}
    let heroTitle = 'Together We Can Make a Difference'
    let heroSubtitle = 'Join thousands of donors empowering education, healthcare, and clean water across the globe.'
    let heroBadge = 'Making A Real Difference'
    let impactTitle = 'Our Impact'
    let impactSubtitle = 'Where Your Money Goes'
    let impactStats = { efficiency: '89%', lives: '14K+', projects: '120+', transparency: '100%' }

    for (const row of result.rows) {
      if (row.key === 'content') {
        try {
          const content = JSON.parse(row.value)
          socialLinks = content.social_links || {}
          heroTitle = content.hero_title || heroTitle
          heroSubtitle = content.hero_subtitle || heroSubtitle
          heroBadge = content.hero_badge || heroBadge
          impactTitle = content.impact_title || impactTitle
          impactSubtitle = content.impact_subtitle || impactSubtitle
          impactStats = content.impact_stats || impactStats
        } catch (err) {
          console.warn('Failed to parse content settings:', err.message)
        }
      }
    }

    res.json({
      social_links: socialLinks,
      hero_title: heroTitle,
      hero_subtitle: heroSubtitle,
      hero_badge: heroBadge,
      impact_title: impactTitle,
      impact_subtitle: impactSubtitle,
      impact_stats: impactStats,
    })
  } catch (err) {
    console.error('Error fetching public settings:', err.message)
    // Return default values instead of failing
    res.json({
      social_links: {},
      hero_title: 'Together We Can Make a Difference',
      hero_subtitle: 'Join thousands of donors empowering education, healthcare, and clean water across the globe.',
      hero_badge: 'Making A Real Difference',
      impact_title: 'Our Impact',
      impact_subtitle: 'Where Your Money Goes',
      impact_stats: { efficiency: '89%', lives: '14K+', projects: '120+', transparency: '100%' }
    })
  }
})

// GET /api/maintenance-status – returns maintenance mode status for frontend
router.get('/maintenance-status', async (req, res, next) => {
  try {
    // Get maintenance mode setting
    const modeResult = await pool.query(
      "SELECT value FROM settings WHERE key = 'maintenance_mode'"
    )
    const enabled = modeResult.rows.length ? modeResult.rows[0].value === 'true' : false
    
    // Get maintenance message
    const messageResult = await pool.query(
      "SELECT value FROM settings WHERE key = 'maintenance_message'"
    )
    const message = messageResult.rows.length 
      ? messageResult.rows[0].value 
      : 'We are currently performing scheduled maintenance. Please check back soon!'
    
    res.json({
      maintenance_mode: enabled,
      enabled: enabled,
      message: message
    })
  } catch (err) {
    console.error('Failed to get maintenance status:', err.message)
    // Return default values (maintenance OFF) instead of failing
    res.json({
      maintenance_mode: false,
      enabled: false,
      message: 'We are currently performing scheduled maintenance. Please check back soon!'
    })
  }
})

// GET /api/health – simple health check for frontend
router.get('/health', async (req, res) => {
  try {
    // Check database connection
    await pool.query('SELECT 1')
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected'
    })
  } catch (err) {
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: err.message
    })
  }
})

// GET /api/stats/public – public platform statistics (for homepage)
router.get('/stats/public', async (req, res, next) => {
  try {
    const [campaignsResult, donationsResult, usersResult] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM campaigns WHERE status = 'approved'"),
      pool.query("SELECT COALESCE(SUM(amount), 0) FROM donations WHERE escrow_status = 'released'"),
      pool.query("SELECT COUNT(*) FROM users WHERE role = 'donor'")
    ])
    
    res.json({
      total_campaigns: parseInt(campaignsResult.rows[0].count),
      total_raised: parseFloat(donationsResult.rows[0].coalesce),
      total_donors: parseInt(usersResult.rows[0].count)
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/categories – get all campaign categories
router.get('/categories', async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT category, COUNT(*) as count 
      FROM campaigns 
      WHERE status = 'approved' 
      GROUP BY category 
      ORDER BY category
    `)
    res.json({ categories: result.rows })
  } catch (err) {
    next(err)
  }
})

module.exports = router