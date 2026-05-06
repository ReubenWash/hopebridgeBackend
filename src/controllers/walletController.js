const pool = require('../config/db');

// Get wallet balance
const getBalance = async (req, res, next) => {
  try {
    const result = await pool.query('SELECT balance FROM wallets WHERE user_id = $1', [req.user.id]);
    if (result.rows.length === 0) {
      // Create wallet if missing
      await pool.query('INSERT INTO wallets (user_id, balance) VALUES ($1, 0)', [req.user.id]);
      return res.json({ balance: 0 });
    }
    res.json({ balance: parseFloat(result.rows[0].balance) });
  } catch (err) { next(err); }
};

// Get transaction history
const getTransactions = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ transactions: result.rows });
  } catch (err) { next(err); }
};

// Request a deposit (user initiates)
const requestDeposit = async (req, res, next) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < 1) return res.status(400).json({ error: 'Amount must be at least $1' });

    const result = await pool.query(
      `INSERT INTO deposit_requests (user_id, amount, status)
       VALUES ($1, $2, 'pending') RETURNING *`,
      [req.user.id, amount]
    );
    res.status(201).json({ message: 'Deposit request created. Awaiting admin instructions.', request: result.rows[0] });
  } catch (err) { next(err); }
};

// Get user's deposit requests
const getMyDepositRequests = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM deposit_requests WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ requests: result.rows });
  } catch (err) { next(err); }
};

// Upload proof after admin gave payment instructions
const uploadProof = async (req, res, next) => {
  try {
    const { requestId } = req.params;
    const proofImageUrl = req.file ? `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}` : req.body.proof_image_url;
    if (!proofImageUrl) return res.status(400).json({ error: 'Proof image is required' });

    const result = await pool.query(
      `UPDATE deposit_requests 
       SET proof_image_url = $1, status = 'awaiting_proof' 
       WHERE id = $2 AND user_id = $3 AND status = 'pending'
       RETURNING *`,
      [proofImageUrl, requestId, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Request not found or already processed' });
    res.json({ message: 'Proof uploaded. Admin will verify.', request: result.rows[0] });
  } catch (err) { next(err); }
};

// Donate from wallet
const donateFromWallet = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { campaign_id, amount, donor_name, donor_email, message, is_monthly } = req.body;
    if (!campaign_id || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid campaign and amount required' });
    }

    // Start transaction
    await client.query('BEGIN');

    // Check wallet balance
    const wallet = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    if (wallet.rows.length === 0) throw new Error('Wallet not found');
    if (parseFloat(wallet.rows[0].balance) < amount) {
      return res.status(400).json({ error: 'Insufficient wallet balance' });
    }

    // Deduct from wallet
    await client.query('UPDATE wallets SET balance = balance - $1 WHERE user_id = $2', [amount, req.user.id]);

    // Record donation (payment_method = 'wallet')
    const donation = await client.query(
      `INSERT INTO donations (campaign_id, donor_name, donor_email, amount, message, is_monthly, payment_method)
       VALUES ($1, $2, $3, $4, $5, $6, 'wallet') RETURNING *`,
      [campaign_id, donor_name || req.user.name, donor_email || req.user.email, amount, message || '', is_monthly || false]
    );

    // Update campaign raised amount
    await client.query(
      `UPDATE campaigns SET raised = (SELECT COALESCE(SUM(amount),0) FROM donations WHERE campaign_id = $1) WHERE id = $1`,
      [campaign_id]
    );

    // Record transaction in ledger
    await client.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, reference_id, description)
       VALUES ($1, $2, 'donation_out', $3, $4)`,
      [req.user.id, amount, donation.rows[0].id, `Donation to campaign #${campaign_id}`]
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: `Donation of $${amount} completed from wallet!`,
      donation: donation.rows[0],
      new_balance: parseFloat(wallet.rows[0].balance) - amount,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

module.exports = {
  getBalance,
  getTransactions,
  requestDeposit,
  getMyDepositRequests,
  uploadProof,
  donateFromWallet,
};