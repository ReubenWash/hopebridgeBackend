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
        payment_method VARCHAR(20) DEFAULT 'card',    -- 'card', 'paypal', 'wallet'
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

      -- WALLET SYSTEM TABLES
      -- Wallets (one per user)
      CREATE TABLE IF NOT EXISTS wallets (
        user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        balance     NUMERIC(12,2) NOT NULL DEFAULT 0,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Deposit requests (user asks to add money)
      CREATE TABLE IF NOT EXISTS deposit_requests (
        id                 SERIAL PRIMARY KEY,
        user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount             NUMERIC(12,2) NOT NULL CHECK (amount > 0),
        status             VARCHAR(20) NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','awaiting_proof','approved','rejected')),
        admin_instructions TEXT,
        payment_method     VARCHAR(50),
        payment_details    TEXT,
        proof_image_url    VARCHAR(500),
        admin_notes        TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Transaction ledger
      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount       NUMERIC(12,2) NOT NULL,
        type         VARCHAR(30) NOT NULL
                     CHECK (type IN ('deposit','donation_out','refund_in')),
        reference_id INTEGER, -- donation.id or deposit_request.id
        description  TEXT,
        status       VARCHAR(20) DEFAULT 'completed',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Auto-update updated_at function (already exists, but safe to re‑create)
      CREATE OR REPLACE FUNCTION update_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql;

      -- Apply updated_at triggers
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

      DROP TRIGGER IF EXISTS wallets_updated_at ON wallets;
      CREATE TRIGGER wallets_updated_at
        BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();

      DROP TRIGGER IF EXISTS deposit_requests_updated_at ON deposit_requests;
      CREATE TRIGGER deposit_requests_updated_at
        BEFORE UPDATE ON deposit_requests
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();

      -- Trigger to create wallet automatically for new users
      CREATE OR REPLACE FUNCTION create_wallet_for_new_user()
      RETURNS TRIGGER AS $$
      BEGIN
        INSERT INTO wallets (user_id, balance) VALUES (NEW.id, 0)
        ON CONFLICT (user_id) DO NOTHING;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS create_wallet_trigger ON users;
      CREATE TRIGGER create_wallet_trigger
        AFTER INSERT ON users
        FOR EACH ROW
        EXECUTE FUNCTION create_wallet_for_new_user();
    `);

    // ── Existing columns & tables (idempotent) ──────────────────────────
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_expires TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT;
      ALTER TABLE donations ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) DEFAULT 'card';
      CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
      CREATE TABLE IF NOT EXISTS creator_payment_methods (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        paypal_email TEXT NOT NULL
      );
    `);

    // ── Create wallets for existing users that don't have one yet ────────
    await client.query(`
      INSERT INTO wallets (user_id, balance)
      SELECT id, 0 FROM users
      WHERE id NOT IN (SELECT user_id FROM wallets)
    `);

    console.log('✅ Migrations complete — all tables (including wallet system) created/updated.')
  } catch (err) {
    console.error('❌ Migration failed:', err.message)
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

migrate().catch(() => process.exit(1))