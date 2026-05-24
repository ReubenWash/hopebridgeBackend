const pool = require('../config/db');
const path = require('path');
const fs = require('fs');
const { sendDepositStatusEmail, sendWithdrawalStatusEmail } = require('../utils/email');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('📁 Created uploads directory for deposit proofs');
}

// ─────────────────────────────────────────────
// GET ALL DEPOSIT REQUESTS
// ─────────────────────────────────────────────
const getAllDepositRequests = async (req, res, next) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT dr.*, u.name, u.email
      FROM deposit_requests dr
      JOIN users u ON dr.user_id = u.id
    `;
    const params = [];
    if (status) {
      query += ' WHERE dr.status = $1';
      params.push(status);
    }
    query += ' ORDER BY dr.created_at DESC';

    const result = await pool.query(query, params);
    res.json({ requests: result.rows });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────
// UPDATE DEPOSIT REQUEST (admin provides instructions OR approves/rejects)
// ─────────────────────────────────────────────
const updateDepositRequest = async (req, res, next) => {
  const { id } = req.params;
  const { status, admin_instructions, payment_method, payment_details, admin_notes } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const beforeUpdate = await client.query(
      'SELECT * FROM deposit_requests WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (beforeUpdate.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Request not found' });
    }

    const existing = beforeUpdate.rows[0];

    if (existing.status === 'approved') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Deposit request already approved' });
    }
    if (existing.status === 'rejected') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Deposit request already rejected' });
    }

    if (status === 'approved' && existing.status !== 'awaiting_proof') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot approve: proof has not been uploaded yet' });
    }

    if (status === 'instructions_sent' && (existing.status === 'approved' || existing.status === 'rejected')) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot send instructions for already processed request' });
    }

    let updateQuery = `
      UPDATE deposit_requests
      SET 
        status = COALESCE($1, status),
        admin_instructions = COALESCE($2, admin_instructions),
        payment_method = COALESCE($3, payment_method),
        payment_details = COALESCE($4, payment_details),
        admin_notes = COALESCE($5, admin_notes),
        processed_at = CASE 
          WHEN $1 IN ('approved','rejected') THEN NOW() 
          ELSE processed_at 
        END
      WHERE id = $6
      RETURNING *
    `;

    const result = await client.query(updateQuery, [
      status || null, 
      admin_instructions || null, 
      payment_method || null, 
      payment_details || null, 
      admin_notes || null, 
      id
    ]);

    const request = result.rows[0];

    if (status === 'approved' && existing.status !== 'approved') {
      const existingCredit = await client.query(
        'SELECT id FROM wallet_transactions WHERE reference = $1 AND type = $2',
        [`DEP-${id}`, 'deposit']
      );
      
      if (existingCredit.rows.length === 0) {
        await client.query(
          `INSERT INTO wallets (user_id, balance) VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + $2`,
          [existing.user_id, existing.amount]
        );

        await client.query(
          `INSERT INTO wallet_transactions (user_id, amount, type, reference, description)
           VALUES ($1, $2, 'deposit', $3, $4)`,
          [existing.user_id, existing.amount, `DEP-${id}`, `Deposit request #${id} approved`]
        );
      }
    }

    await client.query('COMMIT');

    const userRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [existing.user_id]);
    if (userRes.rows.length > 0) {
      const user = userRes.rows[0];

      if (status === 'approved') {
        sendDepositStatusEmail({
          to: user.email,
          userName: user.name,
          amount: existing.amount,
          status: 'approved',
          adminNote: admin_notes || null,
          requestId: id,
        }).catch(e => console.warn('Deposit status email failed:', e.message));
      } else if (status === 'rejected') {
        sendDepositStatusEmail({
          to: user.email,
          userName: user.name,
          amount: existing.amount,
          status: 'rejected',
          adminNote: admin_notes || null,
          requestId: id,
        }).catch(e => console.warn('Deposit status email failed:', e.message));
      } else if (status === 'instructions_sent' && admin_instructions) {
        sendDepositStatusEmail({
          to: user.email,
          userName: user.name,
          amount: existing.amount,
          status: 'instructions_sent',
          adminNote: admin_instructions,
          requestId: id,
        }).catch(e => console.warn('Instructions email failed:', e.message));
      }
    }

    res.json({
      message: `Deposit request ${status || 'updated'} successfully`,
      request,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────
// GET ALL WITHDRAWAL REQUESTS
// ─────────────────────────────────────────────
const getAllWithdrawalRequests = async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT wr.*, u.name, u.email
      FROM withdrawal_requests wr
      JOIN users u ON wr.user_id = u.id
      ORDER BY wr.created_at DESC
    `);
    res.json({ withdrawals: result.rows });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────
// APPROVE WITHDRAWAL
// ─────────────────────────────────────────────
const approveWithdrawal = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await client.query('BEGIN');

    const wdRes = await client.query(
      'SELECT * FROM withdrawal_requests WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (wdRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Request not found' });
    }

    const wd = wdRes.rows[0];
    
    if (wd.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Request already processed' });
    }

    const walletRes = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [wd.user_id]
    );
    const balance = parseFloat(walletRes.rows[0]?.balance || 0);
    if (balance < wd.amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'User has insufficient balance' });
    }

    await client.query(
      'UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2',
      [wd.amount, wd.user_id]
    );

    await client.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, reference, description)
       VALUES ($1, $2, 'withdrawal_out', $3, $4)`,
      [wd.user_id, -Math.abs(wd.amount), `WD-${id}`, `Withdrawal approved (ID: ${id})`]
    );

    await client.query(
      `UPDATE withdrawal_requests SET status = 'approved', processed_at = NOW() WHERE id = $1`,
      [id]
    );

    await client.query('COMMIT');

    const userRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [wd.user_id]);
    if (userRes.rows.length > 0) {
      sendWithdrawalStatusEmail({
        to: userRes.rows[0].email,
        userName: userRes.rows[0].name,
        amount: wd.amount,
        status: 'approved',
        adminNote: null,
      }).catch(e => console.warn('Withdrawal approval email failed:', e.message));
    }

    res.json({ message: 'Withdrawal approved and wallet debited' });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────
// REJECT WITHDRAWAL
// ─────────────────────────────────────────────
const rejectWithdrawal = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason = 'Rejected by admin' } = req.body;

    const checkRes = await pool.query(
      'SELECT status FROM withdrawal_requests WHERE id = $1',
      [id]
    );
    
    if (checkRes.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }
    
    if (checkRes.rows[0].status !== 'pending') {
      return res.status(400).json({ error: 'Request already processed' });
    }

    const result = await pool.query(
      `UPDATE withdrawal_requests
       SET status = 'rejected', admin_note = $1, processed_at = NOW()
       WHERE id = $2 AND status = 'pending'
       RETURNING *`,
      [reason, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found or already processed' });
    }

    const wd = result.rows[0];

    const userRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [wd.user_id]);
    if (userRes.rows.length > 0) {
      sendWithdrawalStatusEmail({
        to: userRes.rows[0].email,
        userName: userRes.rows[0].name,
        amount: wd.amount,
        status: 'rejected',
        adminNote: reason,
      }).catch(e => console.warn('Withdrawal rejection email failed:', e.message));
    }

    res.json({ message: 'Withdrawal rejected', request: wd });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────
// MANUAL WALLET ADJUSTMENT (Admin)
// ─────────────────────────────────────────────
const adjustWalletBalance = async (req, res, next) => {
  const { userId, amount, reason } = req.body;
  const client = await pool.connect();

  try {
    if (!userId || !amount || amount === 0) {
      return res.status(400).json({ error: 'User ID and non-zero amount are required' });
    }

    await client.query('BEGIN');

    // Check if user exists
    const userCheck = await client.query(
      'SELECT id, name, email FROM users WHERE id = $1',
      [userId]
    );
    if (userCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userCheck.rows[0];
    const adjustmentAmount = parseFloat(amount);

    // Update wallet balance
    await client.query(
      `INSERT INTO wallets (user_id, balance) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + $2`,
      [userId, adjustmentAmount]
    );

    // Record transaction
    const transactionType = adjustmentAmount > 0 ? 'admin_credit' : 'admin_debit';
    const transactionDesc = adjustmentAmount > 0 
      ? `Admin credit: ${reason || 'Manual adjustment'}`
      : `Admin debit: ${reason || 'Manual adjustment'}`;

    await client.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, reference, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, adjustmentAmount, transactionType, `ADMIN-${Date.now()}`, transactionDesc]
    );

    // Log to audit
    await client.query(
      `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.user.id, 'wallet_adjustment', 'wallet', userId, JSON.stringify({ amount, reason, user }), req.ip]
    );

    await client.query('COMMIT');

    // Get new balance
    const newBalance = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [userId]
    );

    res.json({
      message: `Wallet adjusted by $${Math.abs(adjustmentAmount).toFixed(2)} (${adjustmentAmount > 0 ? 'credited' : 'debited'})`,
      userId: user.id,
      userName: user.name,
      adjustment: adjustmentAmount,
      newBalance: parseFloat(newBalance.rows[0]?.balance || 0)
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────
// GET USER WALLET DETAILS (Admin)
// ─────────────────────────────────────────────
const getUserWalletDetails = async (req, res, next) => {
  try {
    const { userId } = req.params;

    const userCheck = await pool.query(
      'SELECT id, name, email, role FROM users WHERE id = $1',
      [userId]
    );
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const wallet = await pool.query(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [userId]
    );

    const transactions = await pool.query(
      `SELECT * FROM wallet_transactions 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 50`,
      [userId]
    );

    res.json({
      user: userCheck.rows[0],
      balance: parseFloat(wallet.rows[0]?.balance || 0),
      transactions: transactions.rows
    });
  } catch (err) { next(err); }
};

module.exports = {
  getAllDepositRequests,
  updateDepositRequest,
  getAllWithdrawalRequests,
  approveWithdrawal,
  rejectWithdrawal,
  adjustWalletBalance,
  getUserWalletDetails,
};