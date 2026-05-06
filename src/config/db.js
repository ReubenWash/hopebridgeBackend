const { Pool } = require('pg')
require('dotenv').config()

const isProduction = process.env.NODE_ENV === 'production'

// Build connection configuration
let config = {
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
}

if (process.env.DATABASE_URL) {
  // Use the full connection string (provided by Render or other platforms)
  config.connectionString = process.env.DATABASE_URL
  if (isProduction) {
    config.ssl = { rejectUnauthorized: false }
  }
} else {
  // Fallback to individual environment variables for local development
  config = {
    ...config,
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'hopebridge',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  }
}

const pool = new Pool(config)

// Test connection on startup
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message)
    console.error('   Make sure PostgreSQL is running and environment variables are configured correctly.')
  } else {
    const dbName = process.env.DB_NAME || (process.env.DATABASE_URL ? 'via DATABASE_URL' : 'unknown')
    console.log('✅ Connected to PostgreSQL database:', dbName)
    release()
  }
})

module.exports = pool