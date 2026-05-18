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

// POST /api/auth/register – ALL users need verification if enabled
const register = async (req, res, next) => {
  try {
    const { name, email, password, role = 'donor', recaptchaToken } = req.body;

    // Only allow donor and creator self-registration
    const allowedRoles = ['donor', 'creator'];
    const userRole = allowedRoles.includes(role) ? role : 'donor';

    if (recaptchaToken) {
      await verifyRecaptcha(recaptchaToken);
    }

    // Check if user already exists
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const hash = await bcrypt.hash(password, 10);

    // Check if email verification is enabled in settings
    const verificationEnabled = await getSetting('email_verification_enabled');
    const needsVerification = verificationEnabled === 'true';
    
    // If verification is disabled, auto-verify all users
    const isVerified = !needsVerification;
    const verificationCode = needsVerification ? Math.floor(100000 + Math.random() * 900000).toString() : null;
    const verificationExpires = needsVerification ? new Date(Date.now() + 15 * 60 * 1000) : null;

    const result = await pool.query(
      `INSERT INTO users (name, email, password, role, verification_code, verification_expires, is_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, email, role, is_verified, created_at`,
      [name.trim(), email.toLowerCase().trim(), hash, userRole, verificationCode, verificationExpires, isVerified]
    );

    const user = result.rows[0];

    // Create wallet for new user
    await pool.query(
      `INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
      [user.id]
    );

    const token = signToken(user);

    // Send verification email if verification is enabled
    if (needsVerification && verificationCode) {
      sendVerificationEmail({ to: user.email, name: user.name, code: verificationCode })
        .catch(err => console.warn('Verification email failed:', err.message));
    }

    const message = needsVerification
      ? 'Account created! Please check your email for the verification code.'
      : 'Account created! Welcome to HopeBridge.';

    res.status(201).json({
      message,
      token,
      needsVerification,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        isVerified: user.is_verified,
      },
    });
  } catch (err) { 
    next(err); 
  }
};

// POST /api/auth/login
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
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

// POST /api/auth/verify-code
const verifyCode = async (req, res, next) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and verification code are required.' });
    }

    const result = await pool.query(
      'SELECT id, verification_code, verification_expires FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = result.rows[0];
    if (user.verification_code !== code.trim()) {
      return res.status(400).json({ error: 'Invalid verification code.' });
    }
    if (new Date() > new Date(user.verification_expires)) {
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }

    await pool.query(
      'UPDATE users SET is_verified = true, verification_code = NULL, verification_expires = NULL WHERE id = $1',
      [user.id]
    );

    // Generate token after verification so user can login immediately
    const updatedUser = await pool.query(
      'SELECT id, name, email, role, is_verified, is_active FROM users WHERE id = $1',
      [user.id]
    );
    
    const token = signToken(updatedUser.rows[0]);

    res.json({ 
      message: 'Email verified successfully! You can now log in.',
      token,
      user: updatedUser.rows[0]
    });
  } catch (err) { 
    next(err); 
  }
};

// POST /api/auth/resend-code
const resendCode = async (req, res, next) => {
  try {
    const { email } = req.body;
    const result = await pool.query(
      'SELECT id, name, is_verified FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = result.rows[0];
    if (user.is_verified) {
      return res.status(400).json({ error: 'Email is already verified.' });
    }
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query(
      'UPDATE users SET verification_code = $1, verification_expires = $2 WHERE id = $3',
      [code, expires, user.id]
    );
    sendVerificationEmail({ to: email, name: user.name, code })
      .catch(err => console.warn('Resend verification email failed:', err.message));
    res.json({ message: 'Verification code resent.' });
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