



require('dotenv').config()
const express     = require('express')
const cors        = require('cors')
const helmet      = require('helmet')
const path        = require('path')
const rateLimit   = require('express-rate-limit')

const authRoutes     = require('./routes/auth')
const campaignRoutes = require('./routes/campaigns')
const donationRoutes = require('./routes/donations')
const adminRoutes    = require('./routes/admin')
const publicRoutes   = require('./routes/public')
const { authenticate } = require('./middleware/auth')       // ✅ added
const { errorHandler } = require('./middleware/errorHandler')

const app  = express()
const PORT = process.env.PORT || 5000
const isDev = (process.env.NODE_ENV || 'development') === 'development'

// ── Security middleware ──────────────────────────────────────────
app.use(helmet())
app.use(cors({
  origin:      process.env.CLIENT_URL || 'http://localhost:5173',
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

// ── Static uploads ───────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')))

// ── Health check ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    service: 'HopeBridge API',
    env:     process.env.NODE_ENV || 'development',
    time:    new Date().toISOString(),
  })
})

// ── API Routes ───────────────────────────────────────────────────
app.use('/api/auth',      authLimiter, authRoutes)
app.use('/api/campaigns', campaignRoutes)
app.use('/api/donations', donationRoutes)
app.use('/api/admin',     authenticate, adminRoutes)  // ✅ authenticate runs once here
app.use('/api',           publicRoutes)

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
