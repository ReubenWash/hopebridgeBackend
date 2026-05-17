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
const userRoutes     = require('./routes/users')

const { authenticate } = require('./middleware/auth')
const { errorHandler } = require('./middleware/errorHandler')
const { migrate } = require('./config/migrate')
const pool = require('./config/db')

const app = express()

// Trust proxy (required for Koyeb / rate-limit)
app.set('trust proxy', 1)

const PORT  = process.env.PORT || 5000
const isDev = (process.env.NODE_ENV || 'development') === 'development'

/* ── Uploads directory ──────────────────────────── */
const uploadsDir = path.join(__dirname, '..', 'uploads')
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
  console.log('📁 Created uploads directory')
}

/* ── CORS ───────────────────────────────────────── */
const rawOrigins = process.env.CLIENT_URL || ''
const allowedOrigins = [
  ...rawOrigins.split(',').map(o => o.trim()).filter(Boolean),
  'https://hopebridge-inky.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
]

console.log('🌐 CORS allowed origins:', allowedOrigins)

/* ── Helmet ─────────────────────────────────────── */
// ✅ FIX: connectSrc must include your own API domain so the browser
//    doesn't block fetch() calls to the backend from the frontend.
const apiDomain = process.env.API_URL || 'https://cooing-rosanna-rub-3a11fd0e.koyeb.app'

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", 'https://www.recaptcha.net', 'https://www.google.com'],
      frameSrc:   ["'self'"],
      // ✅ Added apiDomain + Cloudinary so uploads & API calls aren't blocked
      connectSrc: ["'self'", apiDomain, 'https://api.cloudinary.com', 'https://res.cloudinary.com'],
      imgSrc:     ["'self'", 'data:', 'https:', 'blob:'],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https:'],
    },
  },
}))

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true)   // curl / mobile / server-to-server
    if (allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      console.warn('🚫 Blocked CORS from:', origin)
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}))

// Handle all preflight requests
app.options('*', cors())

/* ── Static uploads ─────────────────────────────── */
app.use('/uploads', (req, res, next) => {
  const origin = req.headers.origin
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  next()
}, express.static(uploadsDir))

/* ── Rate limiters ──────────────────────────────── */
const mkLimiter = (max, windowMs = 15 * 60 * 1000, message = 'Too many requests.') =>
  rateLimit({
    windowMs,
    max: isDev ? 1_000_000 : max,
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => isDev,
  })

const relaxedLimiter = mkLimiter(500)
const authLimiter    = mkLimiter(20,  15 * 60 * 1000, 'Too many auth attempts. Try again later.')
const paymentLimiter = mkLimiter(15,  10 * 60 * 1000, 'Too many payment attempts. Please wait.')

/* ── Body parsers ───────────────────────────────── */
app.use('/api/webhooks', express.raw({ type: 'application/json' }))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

/* ── Health check ───────────────────────────────── */
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    service: 'HopeBridge API',
    env:     process.env.NODE_ENV || 'development',
    time:    new Date().toISOString(),
  })
})

/* ── Cloudinary config check (remove after confirming) ── */
app.get('/debug-cloudinary', (req, res) => {
  res.json({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME ? '✅ set' : '❌ MISSING',
    api_key:    process.env.CLOUDINARY_API_KEY    ? '✅ set' : '❌ MISSING',
    api_secret: process.env.CLOUDINARY_API_SECRET ? '✅ set' : '❌ MISSING',
    node_env:   process.env.NODE_ENV || 'not set',
  })
})

/* ── Keep-alive self-ping (prevents Koyeb cold starts) ── */
// Pings /health every 14 minutes so the free-tier service stays warm.
if (!isDev) {
  const PING_INTERVAL = 14 * 60 * 1000 // 14 minutes
  const selfUrl = `${apiDomain}/health`

  setInterval(async () => {
    try {
      const res = await fetch(selfUrl)
      console.log(`🏓 Keep-alive ping → ${res.status}`)
    } catch (err) {
      console.warn('⚠️  Keep-alive ping failed:', err.message)
    }
  }, PING_INTERVAL)

  console.log(`🏓 Keep-alive enabled — pinging ${selfUrl} every 14 min`)
}

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
    res.json({ message: 'Admin ready. Login: admin@hopebridge.com / admin123' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/* ── API routes ─────────────────────────────────── */
app.use('/api/campaigns', relaxedLimiter, campaignRoutes)
app.use('/api/users',     relaxedLimiter, userRoutes)
app.use('/api',           publicRoutes)
app.use('/api/auth',      authLimiter,    authRoutes)
app.use('/api/donations', paymentLimiter, donationRoutes)
app.use('/api/admin',     authenticate,   adminRoutes)
app.use('/api/wallet',    walletRoutes)   // auth handled per-route

/* ── 404 ────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found.` })
})

/* ── Error handler ──────────────────────────────── */
app.use(errorHandler)

/* ── Migrations + start ─────────────────────────── */
const runMigrations = async () => {
  console.log('🔧 Running database migrations…')
  try {
    await migrate(false)
    console.log('✅ Migrations complete')
  } catch (err) {
    console.error('❌ Migration failed:', err.message)
  }
}

runMigrations().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 HopeBridge API → http://localhost:${PORT}`)
    console.log(`   Env          : ${process.env.NODE_ENV || 'development'}`)
    console.log(`   CORS origins : ${allowedOrigins.join(', ')}`)
    console.log(`   Rate limits  : ${isDev ? 'DISABLED (dev)' : 'ENABLED'}`)
    console.log(`   Cloudinary   : ${process.env.CLOUDINARY_CLOUD_NAME ? '✅ configured' : '⚠️  NOT configured'}`)
    console.log(`   Health check : http://localhost:${PORT}/health\n`)
  })
}).catch(err => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})

module.exports = app