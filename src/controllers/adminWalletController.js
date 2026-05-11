const pool = require('../config/db');
const { sendDepositStatusEmail } = require('../utils/email');

// Get all deposit requests (admin)
const getAllDepositRequests = async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT dr.*, u.name, u.email 
      FROM deposit_requests dr
      JOIN users u ON dr.user_id = u.id
      ORDER BY dr.created_at DESC
    `);
    res.json({ requests: result.rows });
  } catch (err) { next(err); }
};

// Admin updates deposit request (add payment instructions, then later approve/reject)
const updateDepositRequest = async (req, res, next) => {
  const { id } = req.params;
  const { status, admin_instructions, payment_method, payment_details, admin_notes } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get request before update to have user_id and amount
    const beforeUpdate = await client.query(
      'SELECT user_id, amount FROM deposit_requests WHERE id = $1',
      [id]
    );
    if (beforeUpdate.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }
    const { user_id, amount } = beforeUpdate.rows[0];

    // Update request
    const result = await client.query(
      `UPDATE deposit_requests 
       SET status = COALESCE($1, status),
           admin_instructions = COALESCE($2, admin_instructions),
           payment_method = COALESCE($3, payment_method),
           payment_details = COALESCE($4, payment_details),
           admin_notes = COALESCE($5, admin_notes)
       WHERE id = $6 RETURNING *`,
      [status, admin_instructions, payment_method, payment_details, admin_notes, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Request not found' });

    const request = result.rows[0];

    // If approved, credit wallet
    if (status === 'approved') {
      // Credit wallet
      await client.query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [request.amount, request.user_id]);
      // Record ledger entry
      await client.query(
        `INSERT INTO wallet_transactions (user_id, amount, type, reference_id, description)
         VALUES ($1, $2, 'deposit', $3, $4)`,
        [request.user_id, request.amount, id, `Deposit request #${id} approved`]
      );
    }

    await client.query('COMMIT');

    // Send email notification to user if status changed to approved or rejected
    if (status && (status === 'approved' || status === 'rejected')) {
      const userRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [user_id]);
      if (userRes.rows.length > 0) {
        sendDepositStatusEmail({
          to: userRes.rows[0].email,
          userName: userRes.rows[0].name,
          amount: request.amount,
          status,
          adminNote: admin_notes || null,
          requestId: id,
        }).catch(e => console.warn('User deposit status email failed:', e.message));
      }
    }

    res.json({ message: `Deposit request ${status || 'updated'}`, request: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

module.exports = {
  getAllDepositRequests,
  updateDepositRequest,
};