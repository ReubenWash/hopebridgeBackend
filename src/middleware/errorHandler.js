const { validationResult } = require('express-validator')

// Validate express-validator results
const validate = (req, res, next) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array().map(e => ({ field: e.path, message: e.msg })),
    })
  }
  next()
}

// Global error handler (mount last in app)
const errorHandler = (err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ERROR:`, err.message)

  // PostgreSQL unique violation
  if (err.code === '23505') {
    return res.status(409).json({ error: 'A record with that value already exists.' })
  }
  // PostgreSQL foreign key violation
  if (err.code === '23503') {
    return res.status(400).json({ error: 'Referenced record not found.' })
  }

  const status = err.status || 500
  res.status(status).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  })
}

module.exports = { validate, errorHandler }
