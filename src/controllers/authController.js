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

// Helper to verify reCAPTCHA (secret read from DB)
const verifyRecaptcha = async (token) => {
  const secret = await getSetting('recaptcha_secret_key');
  if (!secret) throw new Error('reCAPTCHA secret key not configured in admin settings.');
  const response = await axios.post(
    `https://www.google.com/recaptcha/api/siteverify?secret=${secret}&response=${token}`
  );
  if (!response.data.success) {
    throw new Error('reCAPTCHA verification failed. Please try again.');
  }
};

// POST /api/auth/register – only creators can register
const register = async (req, res, next) => {
  try {
    const { name, email, password, recaptchaToken } = req.body;

    if (!recaptchaToken) {
      return res.status(400).json({ error: 'reCAPTCHA token is required.' });
    }
    await verifyRecaptcha(recaptchaToken);

    // Check if user already exists
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const hash = await bcrypt.hash(password, 10);
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const verificationExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Force role = 'creator' (no donor or admin registration)
    const result = await pool.query(
      `INSERT INTO users (name, email, password, role, verification_code, verification_expires, is_verified)
       VALUES ($1, $2, $3, 'creator', $4, $5, false)
       RETURNING id, name, email, role, created_at`,
      [name.trim(), email.toLowerCase().trim(), hash, verificationCode, verificationExpires]
    );

    const user = result.rows[0];
    const token = signToken(user);

    // Send verification email
    sendVerificationEmail({ to: user.email, name: user.name, code: verificationCode })
      .catch(err => console.warn('Verification email failed:', err.message));

    res.status(201).json({
      message: 'Account created! Please check your email for the verification code.',
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, isVerified: false },
    });
  } catch (err) { next(err); }
};

// POST /api/auth/login – allow verified creators and admins
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

    // For creators, require email verification
    if (user.role === 'creator' && !user.is_verified) {
      return res.status(403).json({ error: 'Please verify your email address before logging in.' });
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
  } catch (err) { next(err); }
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
  } catch (err) { next(err); }
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
  } catch (err) { next(err); }
};

// POST /api/auth/verify-code – verify 6‑digit code
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

    res.json({ message: 'Email verified successfully! You can now log in.' });
  } catch (err) { next(err); }
};

// (Optional) Keep the old token‑based verifyEmail for backward compatibility
const verifyEmail = async (req, res, next) => {
  // Not used in new flow, but kept for safety
  res.status(400).json({ error: 'This endpoint is deprecated. Use /verify-code instead.' });
};

module.exports = {
  register,
  login,
  getMe,
  updateMe,
  verifyEmail,
  verifyCode,
};