const router = require('express').Router();
const { authenticate, requireAdmin } = require('../middleware/auth');
const pool = require('../config/db');

// GET /api/content – public endpoint for frontend
router.get('/', async (req, res, next) => {
  try {
    // Fetch content from settings table (key = 'content')
    const result = await pool.query(
      "SELECT value FROM settings WHERE key = 'content'"
    );
    
    let content = {};
    if (result.rows.length > 0) {
      try {
        content = JSON.parse(result.rows[0].value);
      } catch (err) {
        console.warn('Failed to parse content settings:', err.message);
      }
    }
    
    // Return with defaults if missing
    res.json({
      hero_badge: content.hero_badge || 'Making A Real Difference',
      hero_title: content.hero_title || 'Every Contribution Builds A Brighter Tomorrow',
      hero_subtitle: content.hero_subtitle || 'Join thousands of donors empowering education, healthcare, and clean water across the globe.',
      impact_stats: content.impact_stats || {
        active_projects: 0,
        funds_raised: '$0',
        transparency: '100%',
        program_efficiency: '89%',
        lives_impacted: '14K+',
        projects_funded: '120+'
      },
      social_links: content.social_links || {
        facebook: '#',
        twitter: '#',
        instagram: '#',
        linkedin: '#'
      }
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/content – admin only
router.put('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { hero_badge, hero_title, hero_subtitle, impact_stats, social_links } = req.body;
    const contentValue = JSON.stringify({
      hero_badge,
      hero_title,
      hero_subtitle,
      impact_stats,
      social_links
    });
    
    // Upsert into settings table
    const existing = await pool.query(
      "SELECT id FROM settings WHERE key = 'content'"
    );
    if (existing.rows.length === 0) {
      await pool.query(
        "INSERT INTO settings (key, value) VALUES ('content', $1)",
        [contentValue]
      );
    } else {
      await pool.query(
        "UPDATE settings SET value = $1 WHERE key = 'content'",
        [contentValue]
      );
    }
    
    res.json({ message: 'Content updated successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;