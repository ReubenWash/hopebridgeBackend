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
const adminFeaturesRoutes = require('./routes/adminFeaturesRoutes')

const { authenticate } = require('./middleware/auth')
const { errorHandler } = require('./middleware/errorHandler')
const { migrate } = require('./config/migrate')
const pool = require('./config/db')
const { initFirebase } = require('./config/firebase')

// Initialize Firebase for push notifications
initFirebase();

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

/* ── CORS Configuration (Updated for Vercel) ───────────────────────── */
const rawOrigins = process.env.CLIENT_URL || ''
const allowedOrigins = [
  ...rawOrigins.split(',').map(o => o.trim()).filter(Boolean),
  'https://hopebridge-inky.vercel.app',
  'https://hopebridge-kyz32078d-reubens-projects-1edfc122.vercel.app',
  'https://hopebridge-git-main-reubens-projects-1edfc122.vercel.app',
  'https://hopebridge-*.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:5000',
]

// Allow any Vercel preview deployment
const isVercelPreview = (origin) => {
  return origin && (
    origin.includes('.vercel.app') ||
    origin.includes('vercel.app')
  )
}

console.log('🌐 CORS allowed origins:', allowedOrigins)

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", 'https://www.recaptcha.net', 'https://www.google.com', 'https://vercel.live', 'https://vercel.com'],
      frameSrc:   ["'self'", 'https://vercel.live'],
      connectSrc: ["'self'", apiDomain, 'https://api.cloudinary.com', 'https://res.cloudinary.com', 'https://fcm.googleapis.com', 'https://vercel.live'],
      imgSrc:     ["'self'", 'data:', 'https:', 'blob:', 'https://vercel.com'],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https:'],
    },
  },
}))

// Enhanced CORS middleware
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true)
    
    // Allow any Vercel preview deployment
    if (isVercelPreview(origin)) {
      console.log('✅ CORS allowed (Vercel preview):', origin)
      return callback(null, true)
    }
    
    // Check against allowed origins list
    if (allowedOrigins.includes(origin)) {
      console.log('✅ CORS allowed:', origin)
      callback(null, true)
    } else {
      console.warn('🚫 Blocked CORS from:', origin)
      callback(new Error(`CORS policy: Origin ${origin} not allowed`))
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 86400, // 24 hours
}))

// Pre-flight requests
app.options('*', cors())

/* ── Static uploads with CORS headers ─────────────────────────────── */
app.use('/uploads', (req, res, next) => {
  const origin = req.headers.origin
  if (origin && (allowedOrigins.includes(origin) || isVercelPreview(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
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
    keyGenerator: (req) => {
      // Use IP address for rate limiting behind proxy
      return req.ip || req.connection.remoteAddress
    },
  })

const relaxedLimiter = mkLimiter(500)
const authLimiter    = mkLimiter(20,  15 * 60 * 1000, 'Too many auth attempts. Try again later.')
const notificationLimiter = mkLimiter(10,  60 * 1000, 'Too many notification requests. Please wait.')

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
    cors: {
      allowedOrigins: allowedOrigins,
      vercelPreviews: true,
    },
  })
})

/* ── Debug routes ───────────────────────────────── */
app.get('/debug-cors', (req, res) => {
  res.json({
    allowedOrigins: allowedOrigins,
    clientUrl: process.env.CLIENT_URL,
    requestOrigin: req.headers.origin,
    requestHost: req.headers.host,
    vercelPreview: isVercelPreview(req.headers.origin),
  })
})

app.get('/debug-cloudinary', (req, res) => {
  res.json({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME ? '✅ set' : '❌ MISSING',
    api_key:    process.env.CLOUDINARY_API_KEY    ? '✅ set' : '❌ MISSING',
    api_secret: process.env.CLOUDINARY_API_SECRET ? '✅ set' : '❌ MISSING',
    node_env:   process.env.NODE_ENV || 'not set',
  })
})

app.get('/debug-firebase', (req, res) => {
  res.json({
    firebase_configured: !!process.env.FIREBASE_SERVICE_ACCOUNT || !!process.env.FIREBASE_SERVER_KEY,
    has_service_account: !!process.env.FIREBASE_SERVICE_ACCOUNT,
    has_server_key: !!process.env.FIREBASE_SERVER_KEY,
  })
})

/* ── Keep-alive self-ping (prevents Koyeb cold starts) ── */
if (!isDev) {
  const PING_INTERVAL = 14 * 60 * 1000
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
app.use('/api/donations', relaxedLimiter, donationRoutes)
app.use('/api/admin',     authenticate,   adminRoutes)
app.use('/api/admin/features', authenticate, adminFeaturesRoutes)
app.use('/api/wallet',    walletRoutes)

/* ── 404 handler ────────────────────────────────── */
app.use((req, res) => {
  res.status(404).json({ 
    error: `Route ${req.method} ${req.path} not found.`,
    path: req.path,
    method: req.method,
  })
})

/* ── Global error handler ──────────────────────────────── */
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
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 HopeBridge API → http://0.0.0.0:${PORT}`)
    console.log(`   Env          : ${process.env.NODE_ENV || 'development'}`)
    console.log(`   CORS origins : ${allowedOrigins.join(', ')}`)
    console.log(`   Vercel previews: ✅ Allowed`)
    console.log(`   Rate limits  : ${isDev ? 'DISABLED (dev)' : 'ENABLED'}`)
    console.log(`   Cloudinary   : ${process.env.CLOUDINARY_CLOUD_NAME ? '✅ configured' : '⚠️  NOT configured'}`)
    console.log(`   Firebase     : ${(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVER_KEY) ? '✅ configured' : '⚠️  NOT configured'}`)
    console.log(`   Health check : http://localhost:${PORT}/health\n`)
  })
}).catch(err => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})

module.exports = app