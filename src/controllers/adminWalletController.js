const pool = require('../config/db');

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

    // If approved, credit wallet
    if (status === 'approved') {
      const request = result.rows[0];
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