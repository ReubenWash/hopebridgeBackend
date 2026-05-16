const router = require('express').Router();
const pool = require('../config/db');

// GET /api/users/:id - public user info (for campaign creator display)
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT id, name, email, role, created_at, is_active FROM users WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Don't return sensitive info like password
    const user = result.rows[0];
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

module.exports = router;