const { Pool } = require('pg')
require('dotenv').config()

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'hopebridge',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  // Connection pool settings
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
})

// Test connection on startup
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message)
    console.error('   Make sure PostgreSQL is running and .env is configured correctly.')
  } else {
    console.log('✅ Connected to PostgreSQL database:', process.env.DB_NAME)
    release()
  }
})

module.exports = pool
