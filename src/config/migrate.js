require('dotenv').config()
const pool = require('./db')
const bcrypt = require('bcryptjs')

const migrate = async (closePool = true) => {
  const client = await pool.connect()

  try {
    console.log('🔄 Running migrations...')

    await client.query(`
      -- USERS
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'donor'
          CHECK (role IN ('donor','creator','admin')),
        is_active BOOLEAN DEFAULT true,
        is_verified BOOLEAN DEFAULT false,
        fcm_token TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- CAMPAIGNS
      CREATE TABLE IF NOT EXISTS campaigns (
        id SERIAL PRIMARY KEY,
        creator_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(200) NOT NULL,
        description TEXT,
        goal NUMERIC(12,2) NOT NULL CHECK (goal >= 10),
        raised NUMERIC(12,2) DEFAULT 0,
        image_url TEXT,
        category VARCHAR(80) DEFAULT 'General',
        status VARCHAR(20) DEFAULT 'pending'
          CHECK (status IN ('pending','approved','rejected')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- DONATIONS
      CREATE TABLE IF NOT EXISTS donations (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        donor_name VARCHAR(100),
        donor_email VARCHAR(150),
        amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
        message TEXT,
        is_monthly BOOLEAN DEFAULT false,
        payment_method VARCHAR(20) DEFAULT 'card',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- CREATOR PAYMENT METHODS
      CREATE TABLE IF NOT EXISTS creator_payment_methods (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        account_name TEXT,
        account_number TEXT,
        bank_name TEXT
      );

      -- WALLET
      CREATE TABLE IF NOT EXISTS wallets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        balance NUMERIC(12,2) DEFAULT 0 CHECK (balance >= 0),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- WALLET TRANSACTIONS (LEDGER)
      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        amount NUMERIC(12,2) NOT NULL,
        type VARCHAR(30) NOT NULL
          CHECK (type IN ('deposit','donation_out','refund_in','withdrawal_out')),
        reference VARCHAR(255) UNIQUE,
        description TEXT,
        status VARCHAR(20) DEFAULT 'completed',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- WITHDRAWAL REQUESTS (NEW 🔥)
      CREATE TABLE IF NOT EXISTS withdrawal_requests (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
        status VARCHAR(20) DEFAULT 'pending'
          CHECK (status IN ('pending','approved','rejected','paid')),
        admin_note TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        processed_at TIMESTAMPTZ
      );

      -- AUTO UPDATE FUNCTION
      CREATE OR REPLACE FUNCTION update_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      -- TRIGGERS
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_updated') THEN
          CREATE TRIGGER users_updated
          BEFORE UPDATE ON users
          FOR EACH ROW EXECUTE FUNCTION update_updated_at();
        END IF;
      END $$;

      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'campaigns_updated') THEN
          CREATE TRIGGER campaigns_updated
          BEFORE UPDATE ON campaigns
          FOR EACH ROW EXECUTE FUNCTION update_updated_at();
        END IF;
      END $$;
    `)

    // ✅ Ensure every user has a wallet
    await client.query(`
      INSERT INTO wallets (user_id, balance)
      SELECT id, 0 FROM users
      WHERE id NOT IN (SELECT user_id FROM wallets)
    `)

    // 🔐 Hash passwords
    const adminHash = await bcrypt.hash('admin123', 10)
    const demoHash = await bcrypt.hash('demo123', 10)

    // Admin
    await client.query(`
      INSERT INTO users (name, email, password, role, is_active, is_verified)
      VALUES ('Admin User', 'admin@hopebridge.com', $1, 'admin', true, true)
      ON CONFLICT (email) DO NOTHING
    `, [adminHash])

    // Creator
    await client.query(`
      INSERT INTO users (name, email, password, role, is_active, is_verified)
      VALUES ('Demo Creator', 'creator@demo.com', $1, 'creator', true, true)
      ON CONFLICT (email) DO NOTHING
    `, [demoHash])

    // Donor
    await client.query(`
      INSERT INTO users (name, email, password, role, is_active, is_verified)
      VALUES ('Demo Donor', 'donor@demo.com', $1, 'donor', true, true)
      ON CONFLICT (email) DO NOTHING
    `, [demoHash])

    console.log('✅ Migrations completed successfully')

  } catch (err) {
    console.error('❌ Migration failed:', err.message)
    throw err
  } finally {
    client.release()
    if (closePool) await pool.end()
  }
}

if (require.main === module) {
  migrate(true).catch(() => process.exit(1))
} else {
  module.exports = { migrate }
}