const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const pool = require('../config/db');
const { sendVerificationEmail } = require('../utils/email');

// Helper to get a setting value from the database
const getSetting = async (key) => {
  const res = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return res.rows.length ? res.rows[0].value : null;
};

const signToken = (user) =>
  jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

// Helper to verify reCAPTCHA (optional – skip if key not configured)
const verifyRecaptcha = async (token) => {
  try {
    const secret = await getSetting('recaptcha_secret_key') || process.env.RECAPTCHA_SECRET;
    if (!secret) return; // skip if not configured
    const response = await axios.post(
      `https://www.google.com/recaptcha/api/siteverify?secret=${secret}&response=${token}`
    );
    if (!response.data.success) {
      throw new Error('reCAPTCHA verification failed. Please try again.');
    }
  } catch (err) {
    if (err.message.includes('reCAPTCHA')) throw err;
    // Network error etc – skip silently
  }
};

// GET /api/auth/verification-status - Check if email verification is enabled
const getVerificationStatus = async (req, res, next) => {
  try {
    const enabled = await getSetting('email_verification_enabled');
    res.json({ enabled: enabled === 'true' });
  } catch (err) { 
    next(err); 
  }
};

// GET /api/auth/check-session - Check if user is logged in (for guest donation)
const checkSession = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.json({ authenticated: false });
    }
    res.json({ authenticated: true, user: req.user });
  } catch (err) { 
    next(err); 
  }
};

// POST /api/auth/register – Store pending registration, send code, DON'T create account yet
const register = async (req, res, next) => {
  try {
    const { name, email, password, role = 'donor', recaptchaToken } = req.body;

    // Only allow donor and creator self-registration
    const allowedRoles = ['donor', 'creator'];
    const userRole = allowedRoles.includes(role) ? role : 'donor';

    if (recaptchaToken) {
      await verifyRecaptcha(recaptchaToken);
    }

    // Check if user already exists in main users table
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    // Check if email verification is enabled in settings
    const verificationEnabled = await getSetting('email_verification_enabled');
    const needsVerification = verificationEnabled === 'true';
    
    // If verification is disabled, create account directly
    if (!needsVerification) {
      const hash = await bcrypt.hash(password, 10);
      const result = await pool.query(
        `INSERT INTO users (name, email, password, role, is_verified, created_at)
         VALUES ($1, $2, $3, $4, true, NOW())
         RETURNING id, name, email, role, is_verified`,
        [name.trim(), email.toLowerCase().trim(), hash, userRole]
      );

      const user = result.rows[0];
      await pool.query(
        `INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
        [user.id]
      );

      const token = signToken(user);
      return res.status(201).json({
        message: 'Account created! Welcome to HopeBridge.',
        token,
        needsVerification: false,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          isVerified: user.is_verified,
        },
      });
    }

    // If verification is enabled, store in pending_users table (DON'T create account yet)
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const verificationExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    const hashedPassword = await bcrypt.hash(password, 10);

    // Store in pending_users table
    await pool.query(`
      INSERT INTO pending_users (email, name, password_hash, role, verification_code, verification_expires)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (email) DO UPDATE SET 
        name = EXCLUDED.name,
        password_hash = EXCLUDED.password_hash,
        role = EXCLUDED.role,
        verification_code = EXCLUDED.verification_code,
        verification_expires = EXCLUDED.verification_expires,
        created_at = NOW()
    `, [email.toLowerCase().trim(), name.trim(), hashedPassword, userRole, verificationCode, verificationExpires]);

    // Send verification email
    sendVerificationEmail({ to: email, name, code: verificationCode })
      .catch(err => console.warn('Verification email failed:', err.message));

    res.status(201).json({
      message: 'Verification code sent! Please check your email to complete registration.',
      needsVerification: true,
      email: email,
    });
  } catch (err) { 
    console.error('Registration error:', err);
    next(err); 
  }
};

// POST /api/auth/login
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    
    // Check if there's a pending verification for this email
    const pendingCheck = await pool.query(
      'SELECT * FROM pending_users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    
    if (pendingCheck.rows.length > 0) {
      return res.status(403).json({
        error: 'Please verify your email address before logging in. Check your email for the verification code.',
        needsVerification: true,
        email: email,
      });
    }
    
    const result = await pool.query(
      'SELECT id, name, email, password, role, is_verified, is_active FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = result.rows[0];
    if (!user.is_active) {
      return res.status(403).json({ error: 'Your account has been deactivated.' });
    }

    // Check if verification is required from settings
    const verificationEnabled = await getSetting('email_verification_enabled');
    
    // Only require verification if enabled AND user is not verified
    if (verificationEnabled === 'true' && !user.is_verified) {
      return res.status(403).json({
        error: 'Please verify your email address before logging in.',
        needsVerification: true,
        email: user.email,
      });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = signToken(user);
    res.json({
      message: `Welcome back, ${user.name}!`,
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) { 
    next(err); 
  }
};

// GET /api/auth/me
const getMe = async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, role, is_verified, is_active FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) { 
    next(err); 
  }
};

// PATCH /api/auth/me (update profile)
const updateMe = async (req, res, next) => {
  try {
    const { name } = req.body;
    const result = await pool.query(
      'UPDATE users SET name = $1 WHERE id = $2 RETURNING id, name, email, role',
      [name.trim(), req.user.id]
    );
    res.json({ user: result.rows[0] });
  } catch (err) { 
    next(err); 
  }
};

// POST /api/auth/verify-code - Complete registration AFTER successful verification
const verifyCode = async (req, res, next) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and verification code are required.' });
    }

    // Get pending user from temporary table
    const pendingResult = await pool.query(
      `SELECT * FROM pending_users 
       WHERE email = $1 AND verification_code = $2 AND verification_expires > NOW()`,
      [email.toLowerCase().trim(), code.trim()]
    );

    if (pendingResult.rows.length === 0) {
      // Check if code expired
      const expiredCheck = await pool.query(
        `SELECT * FROM pending_users 
         WHERE email = $1 AND verification_code = $2 AND verification_expires <= NOW()`,
        [email.toLowerCase().trim(), code.trim()]
      );
      
      if (expiredCheck.rows.length > 0) {
        return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
      }
      
      // Check if user already exists (already verified)
      const existingUser = await pool.query(
        'SELECT id, name, email, role, is_verified FROM users WHERE email = $1',
        [email.toLowerCase().trim()]
      );
      
      if (existingUser.rows.length > 0 && existingUser.rows[0].is_verified) {
        const token = signToken(existingUser.rows[0]);
        return res.json({
          message: 'Email already verified! You can now log in.',
          token,
          user: existingUser.rows[0],
        });
      }
      
      return res.status(400).json({ error: 'Invalid verification code.' });
    }

    const pendingUser = pendingResult.rows[0];

    // Check if user already exists (edge case)
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [pendingUser.email]
    );
    
    if (existingUser.rows.length > 0) {
      // User already exists, just mark as verified
      await pool.query(
        'UPDATE users SET is_verified = true WHERE email = $1',
        [pendingUser.email]
      );
      
      // Delete from pending
      await pool.query('DELETE FROM pending_users WHERE email = $1', [pendingUser.email]);
      
      const user = await pool.query(
        'SELECT id, name, email, role, is_verified FROM users WHERE email = $1',
        [pendingUser.email]
      );
      
      const token = signToken(user.rows[0]);
      return res.json({
        message: 'Email verified successfully! You can now log in.',
        token,
        user: user.rows[0],
      });
    }

    // Create the actual user account now
    const result = await pool.query(
      `INSERT INTO users (name, email, password, role, is_verified, created_at)
       VALUES ($1, $2, $3, $4, true, NOW())
       RETURNING id, name, email, role, is_verified`,
      [pendingUser.name, pendingUser.email, pendingUser.password_hash, pendingUser.role]
    );

    const user = result.rows[0];

    // Create wallet for user
    await pool.query(
      `INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
      [user.id]
    );

    // Delete from pending users table
    await pool.query('DELETE FROM pending_users WHERE email = $1', [pendingUser.email]);

    const token = signToken(user);

    res.json({
      message: 'Email verified and account created successfully!',
      token,
      user,
    });
  } catch (err) { 
    console.error('Verification error:', err);
    next(err); 
  }
};

// POST /api/auth/resend-code - Resend verification code
const resendCode = async (req, res, next) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }
    
    // Check if user already exists and is verified
    const existingUser = await pool.query(
      'SELECT id, is_verified FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    
    if (existingUser.rows.length > 0 && existingUser.rows[0].is_verified) {
      return res.status(400).json({ error: 'Email is already verified. Please login.' });
    }
    
    // Get pending registration
    const pendingResult = await pool.query(
      'SELECT * FROM pending_users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    
    if (pendingResult.rows.length === 0) {
      return res.status(404).json({ error: 'No pending registration found for this email. Please register first.' });
    }
    
    const pendingUser = pendingResult.rows[0];
    
    const newCode = Math.floor(100000 + Math.random() * 900000).toString();
    const newExpires = new Date(Date.now() + 15 * 60 * 1000);
    
    await pool.query(
      `UPDATE pending_users 
       SET verification_code = $1, verification_expires = $2 
       WHERE email = $3`,
      [newCode, newExpires, email.toLowerCase().trim()]
    );
    
    sendVerificationEmail({ to: email, name: pendingUser.name, code: newCode })
      .catch(err => console.warn('Resend verification email failed:', err.message));
    
    res.json({ message: 'New verification code sent! Please check your email.' });
  } catch (err) { 
    next(err); 
  }
};

// POST /api/auth/save-pending-donation - Save donation for after login
const savePendingDonation = async (req, res, next) => {
  try {
    const { campaignId, amount, message, isMonthly } = req.body;
    // Store in session or return a token
    // For now, just return success - frontend will store in sessionStorage
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

// GET /api/auth/pending-donation - Get pending donation after login
const getPendingDonation = async (req, res, next) => {
  try {
    // This is handled on frontend with sessionStorage
    res.json({ pending: null });
  } catch (err) {
    next(err);
  }
};

const verifyEmail = async (req, res) => {
  res.status(400).json({ error: 'This endpoint is deprecated. Use /verify-code instead.' });
};

module.exports = {
  register,
  login,
  getMe,
  updateMe,
  verifyEmail,
  verifyCode,
  resendCode,
  getVerificationStatus,
  checkSession,
  savePendingDonation,
  getPendingDonation,
};