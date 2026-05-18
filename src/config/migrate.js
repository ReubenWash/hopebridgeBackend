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
        verification_code VARCHAR(10),
        verification_expires TIMESTAMPTZ,
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
        image_file_id VARCHAR(255),
        category VARCHAR(80) DEFAULT 'General',
        status VARCHAR(20) DEFAULT 'pending'
          CHECK (status IN ('pending','approved','rejected','completed')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        completion_requested BOOLEAN DEFAULT FALSE,
        completion_requested_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      );

      -- CAMPAIGN UPDATES (for campaign profile updates/announcements)
      CREATE TABLE IF NOT EXISTS campaign_updates (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        title VARCHAR(200) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- DONATIONS
      CREATE TABLE IF NOT EXISTS donations (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        donor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        donor_name VARCHAR(100),
        donor_email VARCHAR(150),
        amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
        message TEXT,
        is_monthly BOOLEAN DEFAULT false,
        payment_method VARCHAR(20) DEFAULT 'card',
        payment_reference VARCHAR(255) UNIQUE,
        escrow_status VARCHAR(20) DEFAULT 'held'
          CHECK (escrow_status IN ('held','released','refunded')),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- CREATOR PAYMENT METHODS
      CREATE TABLE IF NOT EXISTS creator_payment_methods (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        account_name TEXT,
        account_number TEXT,
        bank_name TEXT,
        paypal_email TEXT
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
        type VARCHAR(30) NOT NULL,
        reference VARCHAR(255),
        reference_id INTEGER,
        description TEXT,
        status VARCHAR(20) DEFAULT 'completed'
          CHECK (status IN ('completed','pending','failed')),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- DEPOSIT REQUESTS
      CREATE TABLE IF NOT EXISTS deposit_requests (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
        status VARCHAR(30) DEFAULT 'pending'
          CHECK (status IN ('pending','instructions_sent','awaiting_proof','approved','rejected')),
        payment_method VARCHAR(100),
        payment_details TEXT,
        admin_instructions TEXT,
        admin_notes TEXT,
        proof_image_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        processed_at TIMESTAMPTZ
      );

      -- WITHDRAWAL REQUESTS
      CREATE TABLE IF NOT EXISTS withdrawal_requests (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
        payment_method VARCHAR(100) DEFAULT 'bank',
        payment_details TEXT,
        status VARCHAR(20) DEFAULT 'pending'
          CHECK (status IN ('pending','approved','rejected','paid')),
        admin_note TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        processed_at TIMESTAMPTZ
      );

      -- ESCROW HOLDS
      CREATE TABLE IF NOT EXISTS escrow_holds (
        id SERIAL PRIMARY KEY,
        donor_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        donation_id INTEGER REFERENCES donations(id) ON DELETE CASCADE,
        amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
        status VARCHAR(20) DEFAULT 'held'
          CHECK (status IN ('held','released','refunded','cancelled')),
        held_at TIMESTAMPTZ DEFAULT NOW(),
        released_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- SETTINGS
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        key VARCHAR(100) UNIQUE NOT NULL,
        value TEXT NOT NULL
      );

      -- DISPUTES
      CREATE TABLE IF NOT EXISTS disputes (
        id SERIAL PRIMARY KEY,
        type VARCHAR(50),
        description TEXT,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
        reported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        status VARCHAR(20) DEFAULT 'open'
          CHECK (status IN ('open','investigating','resolved')),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- FIREBASE NOTIFICATIONS (for storing admin FCM tokens)
      CREATE TABLE IF NOT EXISTS admin_fcm_tokens (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(admin_id, token)
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

      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'campaign_updates_updated') THEN
          CREATE TRIGGER campaign_updates_updated
          BEFORE UPDATE ON campaign_updates
          FOR EACH ROW EXECUTE FUNCTION update_updated_at();
        END IF;
      END $$;

      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'admin_fcm_tokens_updated') THEN
          CREATE TRIGGER admin_fcm_tokens_updated
          BEFORE UPDATE ON admin_fcm_tokens
          FOR EACH ROW EXECUTE FUNCTION update_updated_at();
        END IF;
      END $$;
    `)

    // Add missing columns if they don't exist (safe ALTER TABLE)
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code VARCHAR(10);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_expires TIMESTAMPTZ;
      ALTER TABLE donations ADD COLUMN IF NOT EXISTS donor_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE donations ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(255);
      ALTER TABLE donations ADD COLUMN IF NOT EXISTS escrow_status VARCHAR(20) DEFAULT 'held';
      ALTER TABLE creator_payment_methods ADD COLUMN IF NOT EXISTS paypal_email TEXT;
      ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS reference_id INTEGER;
      ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS reference VARCHAR(255);
      ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS description TEXT;
      ALTER TABLE deposit_requests ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
      ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
      ALTER TABLE escrow_holds ADD COLUMN IF NOT EXISTS held_at TIMESTAMPTZ DEFAULT NOW();
      ALTER TABLE escrow_holds ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
      ALTER TABLE escrow_holds ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
      ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS completion_requested BOOLEAN DEFAULT FALSE;
      ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS completion_requested_at TIMESTAMPTZ;
      ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
      ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS image_file_id VARCHAR(255);
    `)

    // ✅ FORCE FIX: Add the correct type constraint to wallet_transactions
    await client.query(`
      ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;
      ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_type_check 
      CHECK (type IN ('deposit', 'donation_out', 'refund_in', 'withdrawal_out', 'escrow_hold', 'escrow_release', 'escrow_refund'));
    `)

    // ✅ FORCE FIX: Rename user_id to donor_id in escrow_holds if it exists
    await client.query(`
      DO $$ 
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'escrow_holds' AND column_name = 'user_id') THEN
          ALTER TABLE escrow_holds RENAME COLUMN user_id TO donor_id;
        END IF;
      END $$;
    `)

    // ✅ FORCE FIX: Ensure donor_id column exists (add if missing)
    await client.query(`
      ALTER TABLE escrow_holds ADD COLUMN IF NOT EXISTS donor_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    `)

    // ✅ Insert default settings (including email_verification_enabled and firebase settings)
    await client.query(`
      INSERT INTO settings (key, value) VALUES 
        ('cloudinary_cloud_name', ''),
        ('cloudinary_api_key', ''),
        ('cloudinary_api_secret', ''),
        ('imagekit_public_key', ''),
        ('imagekit_private_key', ''),
        ('imagekit_url_endpoint', ''),
        ('smtp_host', ''),
        ('smtp_port', ''),
        ('smtp_user', ''),
        ('smtp_pass', ''),
        ('recaptcha_site_key', ''),
        ('recaptcha_secret_key', ''),
        ('email_verification_enabled', 'true'),
        ('firebase_server_key', ''),
        ('firebase_sender_id', '')
      ON CONFLICT (key) DO NOTHING;
    `)

    // ✅ Remove old PayPal/Firebase settings if they exist (cleanup)
    await client.query(`
      DELETE FROM settings WHERE key IN (
        'paypal_client_id', 'paypal_client_secret', 'paypal_mode', 'firebase_config'
      );
    `)

    // ✅ Update deposit_requests constraint to include all statuses
    await client.query(`
      ALTER TABLE deposit_requests DROP CONSTRAINT IF EXISTS deposit_requests_status_check;
      ALTER TABLE deposit_requests ADD CONSTRAINT deposit_requests_status_check 
      CHECK (status IN ('pending', 'instructions_sent', 'awaiting_proof', 'approved', 'rejected'));
    `)

    // ✅ Update withdrawal_requests constraint
    await client.query(`
      ALTER TABLE withdrawal_requests DROP CONSTRAINT IF EXISTS withdrawal_requests_status_check;
      ALTER TABLE withdrawal_requests ADD CONSTRAINT withdrawal_requests_status_check 
      CHECK (status IN ('pending', 'approved', 'rejected', 'paid'));
    `)

    // ✅ Update donations escrow_status constraint
    await client.query(`
      ALTER TABLE donations DROP CONSTRAINT IF EXISTS donations_escrow_status_check;
      ALTER TABLE donations ADD CONSTRAINT donations_escrow_status_check 
      CHECK (escrow_status IN ('held', 'released', 'refunded'));
    `)

    // ✅ Ensure campaigns status includes 'completed'
    await client.query(`
      ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;
      ALTER TABLE campaigns ADD CONSTRAINT campaigns_status_check 
      CHECK (status IN ('pending', 'approved', 'rejected', 'completed'));
    `)

    // Ensure every existing user has a wallet
    await client.query(`
      INSERT INTO wallets (user_id, balance)
      SELECT id, 0 FROM users
      WHERE id NOT IN (SELECT user_id FROM wallets)
    `)

    // Seed admin
    const adminHash = await bcrypt.hash('admin123', 10)
    await client.query(`
      INSERT INTO users (name, email, password, role, is_active, is_verified)
      VALUES ('Admin User', 'admin@hopebridge.com', $1, 'admin', true, true)
      ON CONFLICT (email) DO NOTHING
    `, [adminHash])

    // Seed demo creator
    const demoHash = await bcrypt.hash('demo123', 10)
    await client.query(`
      INSERT INTO users (name, email, password, role, is_active, is_verified)
      VALUES ('Demo Creator', 'creator@demo.com', $1, 'creator', true, true)
      ON CONFLICT (email) DO NOTHING
    `, [demoHash])

    // Seed demo donor
    const donorHash = await bcrypt.hash('donor123', 10)
    await client.query(`
      INSERT INTO users (name, email, password, role, is_active, is_verified)
      VALUES ('Demo Donor', 'donor@demo.com', $1, 'donor', true, true)
      ON CONFLICT (email) DO NOTHING
    `, [donorHash])

    // Ensure all users have wallets (again, for new users)
    await client.query(`
      INSERT INTO wallets (user_id, balance)
      SELECT id, 0 FROM users
      WHERE id NOT IN (SELECT user_id FROM wallets)
    `)

    console.log('✅ Migrations completed successfully')
    console.log('📁 ImageKit.io storage configured')
    console.log('🔧 Email verification toggle added (default: enabled)')
    console.log('📱 Firebase push notification tables created')
    console.log('🗑️ Removed PayPal settings')
    console.log('🔒 Added wallet_transactions type constraint')
    console.log('📊 Added campaign_updates table for profile updates')
    console.log('✅ Added completed status to campaigns')
    console.log('🖼️ Added image_file_id column for ImageKit.io integration')

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