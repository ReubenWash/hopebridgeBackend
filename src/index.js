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
const { authenticate } = require('./middleware/auth')
const { errorHandler } = require('./middleware/errorHandler')
const { migrate } = require('./config/migrate')
const pool = require('./config/db')

const app = express()
const PORT = process.env.PORT || 5000
const isDev = (process.env.NODE_ENV || 'development') === 'development'

// ── Create uploads directory if it doesn't exist ─────────────────
const uploadsDir = path.join(__dirname, '..', 'uploads')
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
  console.log('📁 Created uploads directory')
}

// ── CORS: allow multiple origins (comma‑separated from env) ──────
const rawOrigins = process.env.CLIENT_URL || 'http://localhost:5173'
const allowedOrigins = rawOrigins.split(',').map(o => o.trim())

app.use(helmet())
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true)
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins[0] === '*') {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
}))

// ── Static uploads with dynamic CORS header ──────────────────────
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

// ── Rate limiting (relaxed in dev) ───────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 10000 : 100,
  message: { error: 'Too many requests. Please try again later.' },
  skip: () => isDev,
}))

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

// ── Health check ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'HopeBridge API',
    env: process.env.NODE_ENV || 'development',
    time: new Date().toISOString(),
  })
})

// 🔧 TEMPORARY ROUTE – Remove after admin login works 🔧
app.post('/temp-create-admin', async (req, res) => {
  try {
    const hash = await bcrypt.hash('admin123', 10)
    await pool.query(`
      INSERT INTO users (name, email, password, role, is_active, is_verified)
      VALUES ('Admin User', 'admin@hopebridge.com', $1, 'admin', true, true)
      ON CONFLICT (email) DO UPDATE SET password = EXCLUDED.password, is_active = true, is_verified = true
    `, [hash])
    res.json({ message: 'Admin user created/updated with fresh hash. Try login now.' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
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

// ── Run migrations automatically in production (idempotent) ─────
const runMigrations = async () => {
  if (!isDev) {
    console.log('🔧 Running database migrations (production mode)...')
    try {
      await migrate(false)
      console.log('✅ Database migrations completed successfully')
    } catch (err) {
      console.error('❌ Migration failed:', err.message)
    }
  }
}

// ── Start server after migrations ────────────────────────────────
runMigrations().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 HopeBridge API running on http://localhost:${PORT}`)
    console.log(`   Environment : ${process.env.NODE_ENV || 'development'}`)
    console.log(`   Allowed origins: ${allowedOrigins.join(', ')}`)
    console.log(`   Rate limits : ${isDev ? 'DISABLED (dev mode)' : 'ENABLED (production)'}`)
    console.log(`   Health check: http://localhost:${PORT}/health\n`)
  })
}).catch(err => {
  console.error('Fatal error during migration:', err)
  process.exit(1)
})

module.exports = app