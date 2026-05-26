const router = require('express').Router();
const pool = require('../config/db');
const { authenticate, requireAdmin } = require('../middleware/auth');

// GET /api/content – public (used by homepage and admin editor)
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query("SELECT value FROM settings WHERE key = 'content'");
    const defaultContent = {
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
      social_links: {}
    };
    
    if (result.rows.length && result.rows[0].value) {
      const saved = JSON.parse(result.rows[0].value);
      const merged = {
        ...defaultContent,
        ...saved,
        impact_stats: { ...defaultContent.impact_stats, ...(saved.impact_stats || {}) },
        social_links: { ...defaultContent.social_links, ...(saved.social_links || {}) }
      };
      return res.json(merged);
    }
    res.json(defaultContent);
  } catch (err) { next(err); }
});

// PUT /api/content – admin only (used by admin dashboard)
router.put('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { hero_badge, hero_title, hero_subtitle, impact_stats, social_links } = req.body;
    const content = {
      hero_badge,
      hero_title,
      hero_subtitle,
      impact_stats,
      social_links
    };
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('content', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(content)]
    );
    res.json({ message: 'Content updated successfully', content });
  } catch (err) { next(err); }
});

module.exports = router;