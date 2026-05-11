require('dotenv').config()
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const path = require('path')
const fs = require('fs')
const rateLimit = require('express-rate-limit')
const bcrypt = require('bcryptjs')

const authRoutes = require('./routes/auth')
const campaignRoutes = require('./routes/campaigns')
const donationRoutes = require('./routes/donations')
const adminRoutes = require('./routes/admin')
const publicRoutes = require('./routes/public')
const walletRoutes = require('./routes/wallet')
const paymentRoutes = require('./routes/paymentRoutes') // ✅ ADD THIS

const { authenticate } = require('./middleware/auth')
const { errorHandler } = require('./middleware/errorHandler')
const { migrate } = require('./config/migrate')
const pool = require('./config/db')

const app = express()
const PORT = process.env.PORT || 5000
const isDev = (process.env.NODE_ENV || 'development') === 'development'

/* ── Create uploads directory ───────────────────────── */
const uploadsDir = path.join(__dirname, '..', 'uploads')
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
  console.log('📁 Created uploads directory')
}

/* ── CORS ───────────────────────────────────────────── */
const rawOrigins = process.env.CLIENT_URL || 'http://localhost:5173'
const allowedOrigins = rawOrigins.split(',').map(o => o.trim())

app.use(helmet())

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true)
    if (allowedOrigins.includes(origin) || allowedOrigins[0] === '*') {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
}))

/* ── Static uploads ─────────────────────────────────── */
app.use('/uploads', (req, res, next) => {
  const origin = req.headers.origin
  if (origin && (allowedOrigins.includes(origin) || allowedOrigins[0] === '*')) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  } else if (allowedOrigins[0] === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  next()
}, express.static(uploadsDir))

/* ── GLOBAL RATE LIMIT (baseline protection) ────────── */
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 10000 : 200,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isDev,
}))

/* ── AUTH RATE LIMIT (anti-bruteforce) ─────────────── */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 10000 : 20,
  message: { error: 'Too many auth attempts. Try again later.' },
  skipSuccessfulRequests: true,
  skip: () => isDev,
})

/* ── PAYMENT RATE LIMIT (CRITICAL 🔥) ──────────────── */
const paymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: isDev ? 10000 : 10, // VERY strict
  message: { error: 'Too many payment attempts. Please wait.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isDev,
})

/* ── BODY PARSERS ─────────────────────────────────── */
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

/* ── HEALTH CHECK ─────────────────────────────────── */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'HopeBridge API',
    env: process.env.NODE_ENV || 'development',
    time: new Date().toISOString(),
  })
})

/* 🔧 TEMP ADMIN ROUTE (REMOVE IN PROD) */
app.post('/temp-create-admin', async (req, res) => {
  try {
    const hash = await bcrypt.hash('admin123', 10)
    await pool.query(`
      INSERT INTO users (name, email, password, role, is_active, is_verified)
      VALUES ('Admin User', 'admin@hopebridge.com', $1, 'admin', true, true)
      ON CONFLICT (email) 
      DO UPDATE SET password = EXCLUDED.password, is_active = true, is_verified = true
    `, [hash])

    res.json({ message: 'Admin ready. Login now.' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/* ── API ROUTES ───────────────────────────────────── */

// Auth (protected by auth limiter)
app.use('/api/auth', authLimiter, authRoutes)

// Core routes
app.use('/api/campaigns', campaignRoutes)
app.use('/api/donations', donationRoutes)

// 🔐 Protected routes
app.use('/api/admin', authenticate, adminRoutes)
app.use('/api/wallet', authenticate, walletRoutes)

// 💳 PAYMENT ROUTE (CRITICAL ADD)
app.use('/api/payment', paymentLimiter, authenticate, paymentRoutes)

// Public routes
app.use('/api', publicRoutes)

/* ── 404 ─────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found.` })
})

/* ── ERROR HANDLER ───────────────────────────────── */
app.use(errorHandler)

/* ── MIGRATIONS ─────────────────────────────────── */
const runMigrations = async () => {
  if (!isDev) {
    console.log('🔧 Running database migrations...')
    try {
      await migrate(false)
      console.log('✅ Migrations complete')
    } catch (err) {
      console.error('❌ Migration failed:', err.message)
    }
  }
}

/* ── START SERVER ───────────────────────────────── */
runMigrations().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 HopeBridge API running on http://localhost:${PORT}`)
    console.log(`Environment : ${process.env.NODE_ENV || 'development'}`)
    console.log(`Rate limits : ${isDev ? 'DISABLED (dev)' : 'ENABLED'}`)
    console.log(`Payment protection : ACTIVE ✅`)
    console.log(`Health: http://localhost:${PORT}/health\n`)
  })
}).catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})

module.exports = app