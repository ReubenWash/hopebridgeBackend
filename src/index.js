require('dotenv').config()
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const path = require('path')
const fs = require('fs')
const rateLimit = require('express-rate-limit')
const bcrypt = require('bcryptjs')

const authRoutes     = require('./routes/auth')
const campaignRoutes = require('./routes/campaigns')
const donationRoutes = require('./routes/donations')
const adminRoutes    = require('./routes/admin')
const publicRoutes   = require('./routes/public')
const walletRoutes   = require('./routes/wallet')

const { authenticate } = require('./middleware/auth')
const { errorHandler } = require('./middleware/errorHandler')
const { migrate } = require('./config/migrate')
const pool = require('./config/db')

const app = express()
const PORT = process.env.PORT || 5000
const isDev = (process.env.NODE_ENV || 'development') === 'development'

/* ── Create uploads directory ───────────────────── */
const uploadsDir = path.join(__dirname, '..', 'uploads')
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
  console.log('📁 Created uploads directory')
}

/* ── CORS ───────────────────────────────────────── */
const rawOrigins = process.env.CLIENT_URL || 'http://localhost:5173'
const allowedOrigins = rawOrigins.split(',').map(o => o.trim())

// Allow PayPal sandbox/live domains for SDK loading
const paypalDomains = [
  'https://www.paypal.com',
  'https://www.sandbox.paypal.com',
  'https://api-m.paypal.com',
  'https://api-m.sandbox.paypal.com',
]

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://www.paypal.com', 'https://www.sandbox.paypal.com', 'https://www.recaptcha.net', 'https://www.google.com'],
      frameSrc: ["'self'", 'https://www.paypal.com', 'https://www.sandbox.paypal.com'],
      connectSrc: ["'self'", ...paypalDomains, 'https://www.google-analytics.com'],
      imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
    },
  },
}))

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
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}))

// Handle preflight
app.options('*', cors())

/* ── Static uploads ─────────────────────────────── */
app.use('/uploads', (req, res, next) => {
  const origin = req.headers.origin
  if (origin && (allowedOrigins.includes(origin) || allowedOrigins[0] === '*')) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  next()
}, express.static(uploadsDir))

/* ── Rate limits ────────────────────────────────── */
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 100000 : 300,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isDev,
}))

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 100000 : 20,
  message: { error: 'Too many auth attempts. Try again later.' },
  skipSuccessfulRequests: true,
  skip: () => isDev,
})

const paymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: isDev ? 100000 : 15,
  message: { error: 'Too many payment attempts. Please wait.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isDev,
})

/* ── Body parsers ───────────────────────────────── */
// Webhook needs raw body
app.use('/api/webhooks', express.raw({ type: 'application/json' }))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

/* ── Health check ───────────────────────────────── */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'HopeBridge API',
    env: process.env.NODE_ENV || 'development',
    time: new Date().toISOString(),
  })
})

/* ── Temp admin bootstrap (REMOVE IN PRODUCTION) ── */
app.post('/temp-create-admin', async (req, res) => {
  try {
    const hash = await bcrypt.hash('admin123', 10)
    await pool.query(`
      INSERT INTO users (name, email, password, role, is_active, is_verified)
      VALUES ('Admin User', 'admin@hopebridge.com', $1, 'admin', true, true)
      ON CONFLICT (email)
      DO UPDATE SET password = EXCLUDED.password, is_active = true, is_verified = true
    `, [hash])
    await pool.query(`
      INSERT INTO wallets (user_id, balance)
      SELECT id, 0 FROM users WHERE email = 'admin@hopebridge.com'
      ON CONFLICT (user_id) DO NOTHING
    `)
    res.json({ message: 'Admin ready. Login with admin@hopebridge.com / admin123' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/* ── API Routes ─────────────────────────────────── */
app.use('/api/auth',      authLimiter, authRoutes)
app.use('/api/campaigns', campaignRoutes)
app.use('/api/donations', paymentLimiter, donationRoutes)
app.use('/api/admin',     authenticate, adminRoutes)
app.use('/api/wallet',    walletRoutes)    // auth handled per-route
app.use('/api',           publicRoutes)   // public settings

/* ── 404 ────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found.` })
})

/* ── Error handler ──────────────────────────────── */
app.use(errorHandler)

/* ── Migrations ─────────────────────────────────── */
const runMigrations = async () => {
  console.log('🔧 Running database migrations...')
  try {
    await migrate(false)
    console.log('✅ Migrations complete')
  } catch (err) {
    console.error('❌ Migration failed:', err.message)
    // Don't exit – app may still work with existing schema
  }
}

/* ── Start server ───────────────────────────────── */
runMigrations().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 HopeBridge API on http://localhost:${PORT}`)
    console.log(`Environment   : ${process.env.NODE_ENV || 'development'}`)
    console.log(`CORS origins  : ${allowedOrigins.join(', ')}`)
    console.log(`Rate limits   : ${isDev ? 'DISABLED (dev)' : 'ENABLED'}`)
    console.log(`Health check  : http://localhost:${PORT}/health\n`)
  })
}).catch(err => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})

module.exports = app