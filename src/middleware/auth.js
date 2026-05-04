const jwt = require('jsonwebtoken')
const pool = require('../config/db')

// Verify JWT and attach user to req
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided. Please sign in.' })
    }

    const token = authHeader.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    const result = await pool.query(
      'SELECT id, name, email, role, is_active FROM users WHERE id = $1',
      [decoded.id]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found.' })
    }

    const user = result.rows[0]
    if (!user.is_active) {
      return res.status(403).json({ error: 'Your account has been deactivated.' })
    }

    req.user = user
    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired. Please sign in again.' })
    }
    return res.status(401).json({ error: 'Invalid token.' })
  }
}

// Role-based access control
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated.' })
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: `Access denied. Required role: ${roles.join(' or ')}.` })
  }
  next()
}

const requireAdmin   = requireRole('admin')
const requireCreator = requireRole('creator', 'admin')

module.exports = { authenticate, requireRole, requireAdmin, requireCreator }
