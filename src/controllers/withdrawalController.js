const pool = require('../config/db');
const {
  sendWithdrawalRequestAlert,
  sendWithdrawalStatusEmail,
} = require('../utils/email');

// 1️⃣ USER: Request withdrawal
const requestWithdrawal = async (req, res, next) => {
  const client = await pool.connect();

  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Enter a valid amount' });
    }

    await client.query('BEGIN');

    // Lock wallet row
    const walletResult = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [req.user.id]
    );

    if (walletResult.rows.length === 0) {
      throw new Error('Wallet not found');
    }

    const balance = parseFloat(walletResult.rows[0].balance);

    if (balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Create withdrawal request
    const withdrawal = await client.query(
      `INSERT INTO withdrawal_requests (user_id, amount, status)
       VALUES ($1, $2, 'pending')
       RETURNING *`,
      [req.user.id, amount]
    );

    await client.query('COMMIT');

    const withdrawalRequest = withdrawal.rows[0];

    // 🔔 Send admin alert for new withdrawal request
    const adminRes = await pool.query("SELECT email FROM users WHERE role = 'admin' LIMIT 1");
    if (adminRes.rows.length > 0) {
      sendWithdrawalRequestAlert({
        adminEmail: adminRes.rows[0].email,
        userName: req.user.name,
        userEmail: req.user.email,
        amount: withdrawalRequest.amount,
        withdrawalId: withdrawalRequest.id,
      }).catch(e => console.warn('Admin withdrawal alert email failed:', e.message));
    }

    res.status(201).json({
      message: 'Withdrawal request submitted. Awaiting admin approval.',
      request: withdrawalRequest,
    });

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// 2️⃣ USER: Get my withdrawals
const getMyWithdrawals = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM withdrawal_requests
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    res.json({ withdrawals: result.rows });

  } catch (err) {
    next(err);
  }
};

// 3️⃣ ADMIN: Get all withdrawal requests
const getAllWithdrawals = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT wr.*, u.name, u.email
       FROM withdrawal_requests wr
       JOIN users u ON wr.user_id = u.id
       ORDER BY wr.created_at DESC`
    );

    res.json({ withdrawals: result.rows });

  } catch (err) {
    next(err);
  }
};

// 4️⃣ ADMIN: Approve withdrawal (CRITICAL LOGIC)
const approveWithdrawal = async (req, res, next) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    await client.query('BEGIN');

    // Lock withdrawal request
    const withdrawalResult = await client.query(
      `SELECT * FROM withdrawal_requests
       WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (withdrawalResult.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const withdrawal = withdrawalResult.rows[0];

    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: 'Already processed' });
    }

    // Lock wallet
    const walletResult = await client.query(
      `SELECT balance FROM wallets
       WHERE user_id = $1 FOR UPDATE`,
      [withdrawal.user_id]
    );

    const balance = parseFloat(walletResult.rows[0].balance);

    if (balance < withdrawal.amount) {
      throw new Error('User has insufficient balance at approval time');
    }

    // Deduct wallet
    await client.query(
      `UPDATE wallets
       SET balance = balance - $1
       WHERE user_id = $2`,
      [withdrawal.amount, withdrawal.user_id]
    );

    // Record transaction
    await client.query(
      `INSERT INTO wallet_transactions
       (user_id, amount, type, reference, description)
       VALUES ($1, $2, 'withdrawal_out', $3, $4)`,
      [
        withdrawal.user_id,
        withdrawal.amount,
        `WD-${withdrawal.id}`,
        `Withdrawal approved (ID: ${withdrawal.id})`
      ]
    );

    // Update request
    await client.query(
      `UPDATE withdrawal_requests
       SET status = 'approved', processed_at = NOW()
       WHERE id = $1`,
      [id]
    );

    await client.query('COMMIT');

    // 🔔 Send email to user
    const userRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [withdrawal.user_id]);
    if (userRes.rows.length > 0) {
      sendWithdrawalStatusEmail({
        to: userRes.rows[0].email,
        userName: userRes.rows[0].name,
        amount: withdrawal.amount,
        status: 'approved',
        adminNote: null,
      }).catch(e => console.warn('User withdrawal status email failed:', e.message));
    }

    res.json({ message: 'Withdrawal approved and wallet debited' });

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// 5️⃣ ADMIN: Reject withdrawal
const rejectWithdrawal = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const result = await pool.query(
      `UPDATE withdrawal_requests
       SET status = 'rejected',
           admin_note = $1,
           processed_at = NOW()
       WHERE id = $2 AND status = 'pending'
       RETURNING *`,
      [reason || 'Rejected by admin', id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found or already processed' });
    }

    const withdrawal = result.rows[0];

    // 🔔 Send email to user
    const userRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [withdrawal.user_id]);
    if (userRes.rows.length > 0) {
      sendWithdrawalStatusEmail({
        to: userRes.rows[0].email,
        userName: userRes.rows[0].name,
        amount: withdrawal.amount,
        status: 'rejected',
        adminNote: reason || null,
      }).catch(e => console.warn('User withdrawal status email failed:', e.message));
    }

    res.json({
      message: 'Withdrawal rejected',
      request: withdrawal,
    });

  } catch (err) {
    next(err);
  }
};

module.exports = {
  requestWithdrawal,
  getMyWithdrawals,
  getAllWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
};