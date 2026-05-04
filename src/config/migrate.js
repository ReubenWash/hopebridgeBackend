require('dotenv').config()
const pool = require('./db')

const migrate = async () => {
  const client = await pool.connect()
  try {
    console.log('🔄 Running migrations...')

    await client.query(`
      -- Users table (donors + creators + admin)
      CREATE TABLE IF NOT EXISTS users (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(100) NOT NULL,
        email       VARCHAR(150) UNIQUE NOT NULL,
        password    VARCHAR(255) NOT NULL,
        role        VARCHAR(20)  NOT NULL DEFAULT 'donor'
                    CHECK (role IN ('donor','creator','admin')),
        is_active   BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Campaigns table
      CREATE TABLE IF NOT EXISTS campaigns (
        id           SERIAL PRIMARY KEY,
        creator_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title        VARCHAR(200) NOT NULL,
        description  TEXT,
        goal         NUMERIC(12,2) NOT NULL CHECK (goal >= 10),
        raised       NUMERIC(12,2) NOT NULL DEFAULT 0,
        image_url    VARCHAR(500),
        category     VARCHAR(80)  NOT NULL DEFAULT 'General',
        status       VARCHAR(20)  NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected')),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Donations table
      CREATE TABLE IF NOT EXISTS donations (
        id           SERIAL PRIMARY KEY,
        campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        donor_name   VARCHAR(100) NOT NULL,
        donor_email  VARCHAR(150) NOT NULL,
        amount       NUMERIC(10,2) NOT NULL CHECK (amount > 0),
        message      TEXT,
        is_monthly   BOOLEAN NOT NULL DEFAULT false,
        payment_method VARCHAR(20) DEFAULT 'card',    -- 'card' or 'paypal'
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Disputes table
      CREATE TABLE IF NOT EXISTS disputes (
        id           SERIAL PRIMARY KEY,
        type         VARCHAR(50) NOT NULL,
        description  TEXT NOT NULL,
        campaign_id  INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
        reported_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        status       VARCHAR(20) NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','resolved')),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Auto-update updated_at columns
      CREATE OR REPLACE FUNCTION update_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS users_updated_at ON users;
      CREATE TRIGGER users_updated_at
        BEFORE UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();

      DROP TRIGGER IF EXISTS campaigns_updated_at ON campaigns;
      CREATE TRIGGER campaigns_updated_at
        BEFORE UPDATE ON campaigns
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();

      DROP TRIGGER IF EXISTS disputes_updated_at ON disputes;
      CREATE TRIGGER disputes_updated_at
        BEFORE UPDATE ON disputes
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    `)

    // ── New columns & tables (idempotent) ──────────────────────────
    await client.query(`
      -- Add verification fields to users
      ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_expires TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;

      -- Add FCM token to users
      ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT;

      -- Add payment_method to donations (if not already present)
      ALTER TABLE donations ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) DEFAULT 'card';

      -- Settings table (theme, keys, content)
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Creator payment methods
      CREATE TABLE IF NOT EXISTS creator_payment_methods (
        user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        paypal_email  TEXT NOT NULL
      );
    `)

    console.log('✅ Migrations complete — all tables created/updated.')
  } catch (err) {
    console.error('❌ Migration failed:', err.message)
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

migrate().catch(() => process.exit(1))