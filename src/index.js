require('dotenv').config()
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const path = require('path')
const fs = require('fs')
const rateLimit = require('express-rate-limit')

const authRoutes = require('./routes/auth')
const campaignRoutes = require('./routes/campaigns')
const donationRoutes = require('./routes/donations')
const adminRoutes = require('./routes/admin')
const publicRoutes = require('./routes/public')
const walletRoutes = require('./routes/wallet')
const { authenticate } = require('./middleware/auth')
const { errorHandler } = require('./middleware/errorHandler')

const app = express()
const PORT = process.env.PORT || 5000
const isDev = (process.env.NODE_ENV || 'development') === 'development'

// ── Create uploads directory if it doesn't exist ─────────────────
const uploadsDir = path.join(__dirname, '..', 'uploads')
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
  console.log('📁 Created uploads directory')
}

// ── Security middleware ──────────────────────────────────────────
app.use(helmet())
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
}))

// Global rate limit — relaxed in dev, strict in production
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 10000 : 100,
  message: { error: 'Too many requests. Please try again later.' },
  skip: () => isDev,
}))

// Auth rate limit — relaxed in dev, strict in production
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 10000 : 20,
  message: { error: 'Too many auth attempts. Please try again in 15 minutes.' },
  skipSuccessfulRequests: true,
  skip: () => isDev,
})

// ── Body parsers ─────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// ── Static uploads with CORS headers for images ──────────────────
app.use('/uploads', (req, res, next) => {
  // Add headers to allow cross-origin loading of images
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.setHeader('Access-Control-Allow-Origin', process.env.CLIENT_URL || 'http://localhost:5173')
  next()
}, express.static(uploadsDir))

// ── Health check ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'HopeBridge API',
    env: process.env.NODE_ENV || 'development',
    time: new Date().toISOString(),
  })
})

// ── API Routes ───────────────────────────────────────────────────
app.use('/api/auth', authLimiter, authRoutes)
app.use('/api/campaigns', campaignRoutes)
app.use('/api/donations', donationRoutes)
app.use('/api/admin', authenticate, adminRoutes)
app.use('/api/wallet', authenticate, walletRoutes)
app.use('/api', publicRoutes)

// ── 404 handler ──────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found.` })
})

// ── Global error handler ─────────────────────────────────────────
app.use(errorHandler)

// ── Start server ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 HopeBridge API running on http://localhost:${PORT}`)
  console.log(`   Environment : ${process.env.NODE_ENV || 'development'}`)
  console.log(`   Rate limits : ${isDev ? 'DISABLED (dev mode)' : 'ENABLED (production)'}`)
  console.log(`   Health check: http://localhost:${PORT}/health\n`)
})

module.exports = app