const router = require('express').Router()
const pool = require('../config/db')

// GET /api/settings/public – returns public-safe settings (hero, impact stats, social links)
router.get('/settings/public', async (req, res, next) => {
  try {
    // Fetch the 'content' JSON from settings table
    const result = await pool.query(
      "SELECT value FROM settings WHERE key = 'content'"
    )

    let content = {}
    if (result.rows.length > 0) {
      try {
        content = JSON.parse(result.rows[0].value)
      } catch (err) {
        console.warn('Failed to parse content settings:', err.message)
      }
    }

    // Default values (must match the shape admin saves)
    const defaults = {
      hero_badge: 'Making A Real Difference',
      hero_title: 'Every Contribution Builds A Brighter Tomorrow',
      hero_subtitle: 'Join thousands of donors empowering education, healthcare, and clean water across the globe.',
      impact_stats: {
        active_projects: 0,
        funds_raised: '$0',
        transparency: '100%',
        program_efficiency: '89%',
        lives_impacted: '14K+',
        projects_funded: '120+'
      },
      social_links: {
        facebook: '#',
        twitter: '#',
        instagram: '#',
        linkedin: '#'
      }
    }

    // Merge saved content with defaults (saved content takes precedence)
    const merged = {
      hero_badge: content.hero_badge || defaults.hero_badge,
      hero_title: content.hero_title || defaults.hero_title,
      hero_subtitle: content.hero_subtitle || defaults.hero_subtitle,
      impact_stats: { ...defaults.impact_stats, ...(content.impact_stats || {}) },
      social_links: { ...defaults.social_links, ...(content.social_links || {}) }
    }

    res.json(merged)
  } catch (err) {
    console.error('Error fetching public settings:', err.message)
    // Fallback to defaults on error
    res.json({
      hero_badge: 'Making A Real Difference',
      hero_title: 'Every Contribution Builds A Brighter Tomorrow',
      hero_subtitle: 'Join thousands of donors empowering education, healthcare, and clean water across the globe.',
      impact_stats: {
        active_projects: 0,
        funds_raised: '$0',
        transparency: '100%',
        program_efficiency: '89%',
        lives_impacted: '14K+',
        projects_funded: '120+'
      },
      social_links: {
        facebook: '#',
        twitter: '#',
        instagram: '#',
        linkedin: '#'
      }
    })
  }
})

// GET /api/maintenance-status – returns maintenance mode status for frontend
router.get('/maintenance-status', async (req, res, next) => {
  try {
    const modeResult = await pool.query(
      "SELECT value FROM settings WHERE key = 'maintenance_mode'"
    )
    const enabled = modeResult.rows.length ? modeResult.rows[0].value === 'true' : false
    
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