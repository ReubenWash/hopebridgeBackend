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

    // Check if user is verified (for email verification)
    const result = await pool.query(
      'SELECT id, name, email, role, is_active, is_verified FROM users WHERE id = $1',
      [decoded.id]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found.' })
    }

    const user = result.rows[0]
    
    // Check if account is active
    if (!user.is_active) {
      return res.status(403).json({ error: 'Your account has been deactivated.' })
    }

    // Check if email is verified (if verification is required)
    // This is optional - you can skip for certain operations
    const verificationEnabled = await getVerificationSetting()
    if (verificationEnabled === 'true' && !user.is_verified && user.role !== 'admin') {
      // Allow access but mark as unverified - frontend can show verification prompt
      req.user = { ...user, is_verified: false }
    } else {
      req.user = user
    }
    
    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired. Please sign in again.' })
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token. Please sign in again.' })
    }
    console.error('Auth error:', err.message)
    return res.status(401).json({ error: 'Authentication failed.' })
  }
}

// Helper function to get verification setting
const getVerificationSetting = async () => {
  try {
    const result = await pool.query(
      "SELECT value FROM settings WHERE key = 'email_verification_enabled'"
    )
    return result.rows.length ? result.rows[0].value : 'true'
  } catch (err) {
    console.error('Failed to get verification setting:', err.message)
    return 'true'
  }
}

// Role-based access control
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated.' })
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ 
      error: `Access denied. Required role: ${roles.join(' or ')}.`,
      your_role: req.user.role 
    })
  }
  next()
}

// Require email verification (for sensitive operations)
const requireVerified = async (req, res, next) => {
  try {
    const verificationEnabled = await getVerificationSetting()
    if (verificationEnabled === 'true' && !req.user.is_verified && req.user.role !== 'admin') {
      return res.status(403).json({ 
        error: 'Email verification required. Please verify your email address.',
        needsVerification: true 
      })
    }
    next()
  } catch (err) {
    next(err)
  }
}

// Check if user is authenticated (public routes that optionally need user info)
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null
      return next()
    }

    const token = authHeader.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    const result = await pool.query(
      'SELECT id, name, email, role, is_active, is_verified FROM users WHERE id = $1',
      [decoded.id]
    )

    if (result.rows.length > 0 && result.rows[0].is_active) {
      req.user = result.rows[0]
    } else {
      req.user = null
    }
    next()
  } catch (err) {
    req.user = null
    next()
  }
}

// Admin only routes
const requireAdmin = requireRole('admin')

// Creator or Admin routes
const requireCreator = requireRole('creator', 'admin')

// Donor or higher (donor, creator, admin)
const requireDonor = requireRole('donor', 'creator', 'admin')

module.exports = { 
  authenticate, 
  requireRole, 
  requireAdmin, 
  requireCreator,
  requireDonor,
  requireVerified,
  optionalAuth
}