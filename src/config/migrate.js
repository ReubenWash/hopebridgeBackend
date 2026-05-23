require('dotenv').config()
const pool = require('./db')
const bcrypt = require('bcryptjs')

const migrate = async (closePool = true) => {
  const client = await pool.connect()

  try {
    console.log('🔄 Running migrations...')

    // Check if we need to run migrations
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'users'
      )
    `)
    
    const tablesExist = tableCheck.rows[0].exists
    
    if (tablesExist) {
      console.log('📊 Tables already exist, checking for updates...')
    } else {
      console.log('📊 Creating new tables...')
    }

    await client.query(`
      -- ============================================
      -- CORE TABLES
      -- ============================================

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

      -- PENDING USERS (for email verification before account creation)
      CREATE TABLE IF NOT EXISTS pending_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(150) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'donor',
        verification_code VARCHAR(10) NOT NULL,
        verification_expires TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
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

      -- CAMPAIGN UPDATES
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
        platform_fee NUMERIC(10,2) DEFAULT 0,
        net_amount NUMERIC(10,2) DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- CREATOR PAYMENT METHODS
      CREATE TABLE IF NOT EXISTS creator_payment_methods (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        account_name TEXT,
        account_number TEXT,
        bank_name TEXT,
        bank_sort_code VARCHAR(20),
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
        amount NUMERIC(12,2) NOT NULL CHECK (amount != 0),
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
        transaction_id VARCHAR(100),
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
        resolution TEXT,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- FIREBASE NOTIFICATIONS (admin FCM tokens)
      CREATE TABLE IF NOT EXISTS admin_fcm_tokens (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(admin_id, token)
      );

      -- ============================================
      -- ENHANCED FEATURES TABLES
      -- ============================================

      -- PLATFORM FEES
      CREATE TABLE IF NOT EXISTS platform_fees (
        id SERIAL PRIMARY KEY,
        percentage NUMERIC(5,2) DEFAULT 0 CHECK (percentage >= 0 AND percentage <= 100),
        fixed_amount NUMERIC(10,2) DEFAULT 0,
        min_fee NUMERIC(10,2) DEFAULT 0,
        max_fee NUMERIC(10,2),
        withdrawal_fee NUMERIC(10,2) DEFAULT 0,
        minimum_withdrawal NUMERIC(10,2) DEFAULT 10,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        updated_by INTEGER REFERENCES users(id)
      );

      -- AUDIT LOGS
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER REFERENCES users(id),
        action VARCHAR(100) NOT NULL,
        entity_type VARCHAR(50),
        entity_id INTEGER,
        details JSONB,
        ip_address INET,
        user_agent TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- CREATOR VERIFICATIONS
      CREATE TABLE IF NOT EXISTS creator_verifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','needs_review')),
        id_document_url TEXT,
        id_document_type VARCHAR(50),
        id_document_number VARCHAR(100),
        proof_of_address_url TEXT,
        business_registration_url TEXT,
        business_name VARCHAR(200),
        business_tax_id VARCHAR(100),
        bank_account_name VARCHAR(100),
        bank_account_number VARCHAR(50),
        bank_name VARCHAR(100),
        bank_sort_code VARCHAR(20),
        notes TEXT,
        reviewed_by INTEGER REFERENCES users(id),
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- DONOR SUBSCRIPTIONS (Recurring Donations)
      CREATE TABLE IF NOT EXISTS donor_subscriptions (
        id SERIAL PRIMARY KEY,
        donor_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
        amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
        frequency VARCHAR(20) DEFAULT 'monthly' CHECK (frequency IN ('weekly','monthly','yearly')),
        status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','paused','cancelled','expired','failed')),
        next_billing_date DATE,
        last_billing_date DATE,
        total_donated NUMERIC(12,2) DEFAULT 0,
        payment_method VARCHAR(50) DEFAULT 'wallet',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        cancelled_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- PUSH NOTIFICATION LOGS
      CREATE TABLE IF NOT EXISTS push_notifications (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        body TEXT,
        target_type VARCHAR(20) CHECK (target_type IN ('all','donors','creators','admin','specific_user')),
        target_user_id INTEGER REFERENCES users(id),
        sent_count INTEGER DEFAULT 0,
        delivered_count INTEGER DEFAULT 0,
        clicked_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        sent_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- EMAIL TEMPLATES (Customizable)
      CREATE TABLE IF NOT EXISTS email_templates (
        id SERIAL PRIMARY KEY,
        template_key VARCHAR(100) UNIQUE NOT NULL,
        subject TEXT NOT NULL,
        body_html TEXT,
        body_text TEXT,
        variables JSONB,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- ============================================
      -- VIEWS
      -- ============================================

      -- TOP DONORS VIEW (Helper)
      CREATE OR REPLACE VIEW top_donors_view AS
      SELECT 
        u.id,
        u.name,
        u.email,
        COALESCE(SUM(d.amount), 0) as total_donated,
        COUNT(d.id) as donation_count,
        MAX(d.created_at) as last_donation_date
      FROM users u
      LEFT JOIN donations d ON d.donor_id = u.id AND d.escrow_status = 'released'
      WHERE u.role = 'donor'
      GROUP BY u.id
      ORDER BY total_donated DESC;

      -- ============================================
      -- FUNCTIONS & TRIGGERS
      -- ============================================

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

      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'creator_verifications_updated') THEN
          CREATE TRIGGER creator_verifications_updated
          BEFORE UPDATE ON creator_verifications
          FOR EACH ROW EXECUTE FUNCTION update_updated_at();
        END IF;
      END $$;

      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'donor_subscriptions_updated') THEN
          CREATE TRIGGER donor_subscriptions_updated
          BEFORE UPDATE ON donor_subscriptions
          FOR EACH ROW EXECUTE FUNCTION update_updated_at();
        END IF;
      END $$;

      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'platform_fees_updated') THEN
          CREATE TRIGGER platform_fees_updated
          BEFORE UPDATE ON platform_fees
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
      ALTER TABLE donations ADD COLUMN IF NOT EXISTS platform_fee NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE donations ADD COLUMN IF NOT EXISTS net_amount NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE creator_payment_methods ADD COLUMN IF NOT EXISTS paypal_email TEXT;
      ALTER TABLE creator_payment_methods ADD COLUMN IF NOT EXISTS bank_sort_code VARCHAR(20);
      ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS reference_id INTEGER;
      ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS reference VARCHAR(255);
      ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS description TEXT;
      ALTER TABLE deposit_requests ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
      ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
      ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(100);
      ALTER TABLE escrow_holds ADD COLUMN IF NOT EXISTS held_at TIMESTAMPTZ DEFAULT NOW();
      ALTER TABLE escrow_holds ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
      ALTER TABLE escrow_holds ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
      ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS completion_requested BOOLEAN DEFAULT FALSE;
      ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS completion_requested_at TIMESTAMPTZ;
      ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
      ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS image_file_id VARCHAR(255);
      ALTER TABLE disputes ADD COLUMN IF NOT EXISTS resolution TEXT;
      ALTER TABLE disputes ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
      ALTER TABLE creator_verifications ADD COLUMN IF NOT EXISTS id_document_number VARCHAR(100);
      ALTER TABLE creator_verifications ADD COLUMN IF NOT EXISTS business_name VARCHAR(200);
      ALTER TABLE creator_verifications ADD COLUMN IF NOT EXISTS business_tax_id VARCHAR(100);
      ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent TEXT;
    `)

    // Create indexes for better performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pending_users_email ON pending_users(email);
      CREATE INDEX IF NOT EXISTS idx_pending_users_code ON pending_users(verification_code);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_id ON audit_logs(admin_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
      CREATE INDEX IF NOT EXISTS idx_creator_verifications_user_id ON creator_verifications(user_id);
      CREATE INDEX IF NOT EXISTS idx_creator_verifications_status ON creator_verifications(status);
      CREATE INDEX IF NOT EXISTS idx_donor_subscriptions_donor_id ON donor_subscriptions(donor_id);
      CREATE INDEX IF NOT EXISTS idx_donor_subscriptions_status ON donor_subscriptions(status);
      CREATE INDEX IF NOT EXISTS idx_donor_subscriptions_next_billing ON donor_subscriptions(next_billing_date);
      CREATE INDEX IF NOT EXISTS idx_push_notifications_sent_at ON push_notifications(sent_at);
      CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user_id ON withdrawal_requests(user_id);
      CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests(status);
      CREATE INDEX IF NOT EXISTS idx_donations_donor_id ON donations(donor_id);
      CREATE INDEX IF NOT EXISTS idx_donations_campaign_id ON donations(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_donations_created_at ON donations(created_at);
    `)

    // Add the correct type constraint to wallet_transactions
    await client.query(`
      ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;
      ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_type_check 
      CHECK (type IN ('deposit', 'donation_out', 'refund_in', 'withdrawal_out', 'escrow_hold', 'escrow_release', 'escrow_refund', 'fee_deduction'));
    `)

    // Rename user_id to donor_id in escrow_holds if it exists
    await client.query(`
      DO $$ 
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'escrow_holds' AND column_name = 'user_id') THEN
          ALTER TABLE escrow_holds RENAME COLUMN user_id TO donor_id;
        END IF;
      END $$;
    `)

    // Ensure donor_id column exists
    await client.query(`
      ALTER TABLE escrow_holds ADD COLUMN IF NOT EXISTS donor_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    `)

    // Insert default settings
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
        ('push_notifications_enabled', 'true'),
        ('firebase_server_key', ''),
        ('firebase_sender_id', ''),
        ('maintenance_mode', 'false'),
        ('maintenance_message', 'We are currently performing scheduled maintenance. Please check back soon!'),
        ('recaptcha_enabled', 'false')
      ON CONFLICT (key) DO NOTHING;
    `)

    // Insert default email templates
    await client.query(`
      INSERT INTO email_templates (template_key, subject, body_text, variables) VALUES 
        ('verification', 'Your HopeBridge Verification Code', 
         'Hi {{name}},\\n\\nThank you for registering. Your verification code is:\\n\\n{{code}}\\n\\nThis code expires in 15 minutes.\\n\\nIf you didn''t request this, please ignore this email.', 
         '["name","code"]'),
        ('welcome', 'Welcome to HopeBridge, {{name}}!', 
         'Hi {{name}},\\n\\nWelcome to HopeBridge! You joined as a {{role}}.\\n\\nStart making an impact today.\\n\\nBest regards,\\nThe HopeBridge Team', 
         '["name","role"]'),
        ('donation_confirmation', 'Thank you for your donation of ${{amount}}!', 
         'Dear {{donor_name}},\\n\\nThank you for your generous donation of ${{amount}} to {{campaign_title}}.\\n\\nYour support makes a real difference!\\n\\nDonation Details:\\n- Amount: ${{amount}}\\n- Campaign: {{campaign_title}}\\n- Date: {{date}}\\n\\nWith gratitude,\\nThe HopeBridge Team', 
         '["donor_name","amount","campaign_title","date"]'),
        ('campaign_approved', 'Your campaign "{{title}}" has been approved!', 
         'Dear {{creator_name}},\\n\\nGreat news! Your campaign "{{title}}" has been approved and is now live.\\n\\nShare it with your network to start raising funds.\\n\\nCampaign Link: {{campaign_link}}\\n\\nBest of luck!\\nThe HopeBridge Team', 
         '["creator_name","title","campaign_link"]'),
        ('campaign_rejected', 'Update on your campaign "{{title}}"', 
         'Dear {{creator_name}},\\n\\nAfter careful review, your campaign "{{title}}" was not approved.\\n\\nReason: {{reason}}\\n\\nPlease review our guidelines and feel free to resubmit.\\n\\nThe HopeBridge Team', 
         '["creator_name","title","reason"]'),
        ('withdrawal_status', 'Your withdrawal of ${{amount}} has been {{status}}', 
         'Dear {{name}},\\n\\nYour withdrawal request of ${{amount}} has been {{status}}.\\n\\n{{admin_note}}\\n\\nIf you have any questions, please contact support.\\n\\nThe HopeBridge Team', 
         '["name","amount","status","admin_note"]')
      ON CONFLICT (template_key) DO NOTHING;
    `)

    // Insert default platform fees (only if table is empty)
    const feeCheck = await client.query(`SELECT COUNT(*) FROM platform_fees`)
    if (parseInt(feeCheck.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO platform_fees (percentage, fixed_amount, min_fee, max_fee, withdrawal_fee, minimum_withdrawal)
        VALUES (0, 0, 0, NULL, 0, 10)
      `)
    }

    // Remove old PayPal/Firebase settings if they exist (cleanup)
    await client.query(`
      DELETE FROM settings WHERE key IN (
        'paypal_client_id', 'paypal_client_secret', 'paypal_mode', 'firebase_config'
      );
    `)

    // Update deposit_requests constraint
    await client.query(`
      ALTER TABLE deposit_requests DROP CONSTRAINT IF EXISTS deposit_requests_status_check;
      ALTER TABLE deposit_requests ADD CONSTRAINT deposit_requests_status_check 
      CHECK (status IN ('pending', 'instructions_sent', 'awaiting_proof', 'approved', 'rejected'));
    `)

    // Update withdrawal_requests constraint
    await client.query(`
      ALTER TABLE withdrawal_requests DROP CONSTRAINT IF EXISTS withdrawal_requests_status_check;
      ALTER TABLE withdrawal_requests ADD CONSTRAINT withdrawal_requests_status_check 
      CHECK (status IN ('pending', 'approved', 'rejected', 'paid'));
    `)

    // Update donations escrow_status constraint
    await client.query(`
      ALTER TABLE donations DROP CONSTRAINT IF EXISTS donations_escrow_status_check;
      ALTER TABLE donations ADD CONSTRAINT donations_escrow_status_check 
      CHECK (escrow_status IN ('held', 'released', 'refunded'));
    `)

    // Ensure campaigns status includes 'completed'
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

    // Clean up any stale pending users (older than 24 hours)
    await client.query(`
      DELETE FROM pending_users WHERE created_at < NOW() - INTERVAL '24 hours'
    `)

    // Seed admin user
    const adminCheck = await client.query(`SELECT id FROM users WHERE email = 'admin@hopebridge.com'`)
    if (adminCheck.rows.length === 0) {
      const adminHash = await bcrypt.hash('admin123', 10)
      await client.query(`
        INSERT INTO users (name, email, password, role, is_active, is_verified)
        VALUES ('Admin User', 'admin@hopebridge.com', $1, 'admin', true, true)
      `, [adminHash])
      console.log('👑 Admin user created')
    }

    // Seed demo creator
    const creatorCheck = await client.query(`SELECT id FROM users WHERE email = 'creator@demo.com'`)
    if (creatorCheck.rows.length === 0) {
      const demoHash = await bcrypt.hash('demo123', 10)
      await client.query(`
        INSERT INTO users (name, email, password, role, is_active, is_verified)
        VALUES ('Demo Creator', 'creator@demo.com', $1, 'creator', true, true)
      `, [demoHash])
      console.log('👤 Demo creator created')
    }

    // Seed demo donor
    const donorCheck = await client.query(`SELECT id FROM users WHERE email = 'donor@demo.com'`)
    if (donorCheck.rows.length === 0) {
      const donorHash = await bcrypt.hash('donor123', 10)
      await client.query(`
        INSERT INTO users (name, email, password, role, is_active, is_verified)
        VALUES ('Demo Donor', 'donor@demo.com', $1, 'donor', true, true)
      `, [donorHash])
      console.log('👤 Demo donor created')
    }

    // Ensure all users have wallets
    await client.query(`
      INSERT INTO wallets (user_id, balance)
      SELECT id, 0 FROM users
      WHERE id NOT IN (SELECT user_id FROM wallets)
    `)

    console.log('✅ Migrations completed successfully')
    console.log('📁 ImageKit.io storage configured')
    console.log('🔧 Email verification toggle added (default: enabled)')
    console.log('📱 Firebase push notification tables created')
    console.log('👥 Pending users table added for verification flow')
    console.log('💰 Platform fees table created')
    console.log('📝 Audit logs table created')
    console.log('✅ Creator verification table created')
    console.log('🔄 Donor subscriptions table created')
    console.log('📧 Email templates table created')
    console.log('🔔 Push notification logs table created')
    console.log('🗑️ Removed PayPal settings')
    console.log('🔒 Added wallet_transactions type constraint')
    console.log('📊 Added campaign_updates table for profile updates')
    console.log('✅ Added completed status to campaigns')
    console.log('🖼️ Added image_file_id column for ImageKit.io integration')
    console.log('🏆 Top donors view created')

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