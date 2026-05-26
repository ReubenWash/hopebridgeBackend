const pool = require('../config/db');
const {
  sendNewDepositRequestAlert,
  sendNewDonationAdminAlert,
  sendWithdrawalRequestAlert,
  sendDepositStatusEmail,
  sendWithdrawalStatusEmail,
} = require('../utils/email');
const { uploadToImageKit } = require('../config/imagekit'); // 👈 ADD THIS

// ─────────────────────────────────────────────
// WALLET BALANCE
// ─────────────────────────────────────────────
const getBalance = async (req, res, next) => {
  try {
    let result = await pool.query(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      await pool.query(
        'INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING',
        [req.user.id]
      );
      return res.json({ balance: 0, currency: 'USD' });
    }

    res.json({ 
      balance: parseFloat(result.rows[0].balance),
      currency: 'USD',
      formatted: `$${parseFloat(result.rows[0].balance).toFixed(2)}`
    });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────
// TRANSACTION HISTORY
// ─────────────────────────────────────────────
const getTransactions = async (req, res, next) => {
  try {
    const { limit = 100, offset = 0, type } = req.query;
    
    let query = `
      SELECT * FROM wallet_transactions
      WHERE user_id = $1
    `;
    const params = [req.user.id];
    
    if (type) {
      query += ` AND type = $2`;
      params.push(type);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await pool.query(query, params);
    
    // Get total count
    const countQuery = type 
      ? `SELECT COUNT(*) FROM wallet_transactions WHERE user_id = $1 AND type = $2`
      : `SELECT COUNT(*) FROM wallet_transactions WHERE user_id = $1`;
    const countParams = type ? [req.user.id, type] : [req.user.id];
    const countResult = await pool.query(countQuery, countParams);
    
    res.json({ 
      transactions: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────
// REQUEST DEPOSIT (MANUAL / ADMIN FLOW)
// ─────────────────────────────────────────────
const requestDeposit = async (req, res, next) => {
  try {
    const { amount } = req.body;

    if (!amount || parseFloat(amount) < 1) {
      return res.status(400).json({ error: 'Amount must be at least $1' });
    }

    // Check for pending requests to avoid spam
    const pending = await pool.query(
      `SELECT id FROM deposit_requests WHERE user_id = $1 AND status IN ('pending','instructions_sent','awaiting_proof') LIMIT 1`,
      [req.user.id]
    );
    if (pending.rows.length > 0) {
      return res.status(400).json({
        error: 'You already have a pending deposit request. Please complete it before creating a new one.',
        existingId: pending.rows[0].id,
      });
    }

    const result = await pool.query(
      `INSERT INTO deposit_requests (user_id, amount, status)
       VALUES ($1, $2, 'pending') RETURNING *`,
      [req.user.id, parseFloat(amount)]
    );

    const request = result.rows[0];

    // Alert admin
    const adminRes = await pool.query("SELECT email FROM users WHERE role = 'admin' LIMIT 1");
    if (adminRes.rows.length > 0) {
      sendNewDepositRequestAlert({
        adminEmail: adminRes.rows[0].email,
        userName: req.user.name,
        userEmail: req.user.email,
        amount: request.amount,
        requestId: request.id,
      }).catch(e => console.warn('Admin deposit alert email failed:', e.message));
    }

    res.status(201).json({
      message: 'Deposit request submitted. Admin will review and provide payment instructions shortly.',
      request,
    });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────
// GET MY DEPOSIT REQUESTS
// ─────────────────────────────────────────────
const getMyDepositRequests = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM deposit_requests
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ requests: result.rows });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────
// UPLOAD PAYMENT PROOF (FIXED for ImageKit)
// ─────────────────────────────────────────────
const uploadProof = async (req, res, next) => {
  try {
    const { requestId } = req.params;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No proof image uploaded' });
    }

    // Upload to ImageKit
    const fileName = `proof-${requestId}-${Date.now()}.jpg`;
    const uploadResult = await uploadToImageKit(file.buffer, fileName, 'hopebridge/proofs');

    if (!uploadResult || !uploadResult.url) {
      throw new Error('ImageKit upload failed – no URL returned');
    }

    const proofImageUrl = uploadResult.url; // Full ImageKit URL

    const result = await pool.query(
      `UPDATE deposit_requests
       SET proof_image_url = $1, status = 'awaiting_proof', updated_at = NOW()
       WHERE id = $2 AND user_id = $3 AND status IN ('pending','instructions_sent')
       RETURNING *`,
      [proofImageUrl, requestId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Request not found, already processed, or you are not authorized.',
      });
    }

    // Notify admin that proof is ready for review
    const adminRes = await pool.query("SELECT email FROM users WHERE role = 'admin' LIMIT 1");
    if (adminRes.rows.length > 0) {
      sendNewDepositRequestAlert({
        adminEmail: adminRes.rows[0].email,
        userName: req.user.name,
        userEmail: req.user.email,
        amount: result.rows[0].amount,
        requestId,
        proofUploaded: true,
      }).catch(e => console.warn('Admin proof alert email failed:', e.message));
    }

    res.json({
      message: 'Proof uploaded successfully. Admin will verify and credit your wallet.',
      request: result.rows[0],
    });
  } catch (err) {
    console.error('Upload proof error:', err);
    next(err);
  }
};

// ─────────────────────────────────────────────
// DONATE FROM WALLET (MANDATORY ESCROW)
// ─────────────────────────────────────────────
const donateFromWallet = async (req, res, next) => {
  const client = await pool.connect();

  try {
    const {
      campaign_id,
      amount,
      donor_name,
      donor_email,
      message,
      is_monthly,
    } = req.body;

    if (!campaign_id || !amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Valid campaign and amount required' });
    }

    await client.query('BEGIN');

    // Lock wallet row
    const wallet = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [req.user.id]
    );

    if (wallet.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const currentBalance = parseFloat(wallet.rows[0].balance);
    const donationAmount = parseFloat(amount);

    if (currentBalance < donationAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Insufficient wallet balance. Available: $${currentBalance.toFixed(2)}`,
      });
    }

    // Verify campaign
    const campRes = await client.query(
      'SELECT id, title, status, creator_id FROM campaigns WHERE id = $1',
      [campaign_id]
    );
    if (!campRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (campRes.rows[0].status !== 'approved') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Campaign is not accepting donations' });
    }

    // Deduct balance
    await client.query(
      'UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2',
      [donationAmount, req.user.id]
    );

    // Create donation record with escrow_status = 'held'
    const donation = await client.query(
      `INSERT INTO donations
       (campaign_id, donor_id, donor_name, donor_email, amount, message, is_monthly, payment_method, escrow_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'wallet', 'held')
       RETURNING *`,
      [
        campaign_id,
        req.user.id,
        donor_name || req.user.name,
        donor_email || req.user.email,
        donationAmount,
        message || '',
        is_monthly || false,
      ]
    );

    const donationRow = donation.rows[0];

    // Wallet transaction ledger entry (using 'donation' type instead of 'donation_out')
    await client.query(
      `INSERT INTO wallet_transactions
       (user_id, amount, type, reference_id, description, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        req.user.id,
        -donationAmount,  // negative because money leaves wallet
        'donation',
        donationRow.id,
        `Donation to "${campRes.rows[0].title}" (held in escrow)`,
        'completed'
      ]
    );

    // Create escrow hold record
    await client.query(
      `INSERT INTO escrow_holds (donor_id, campaign_id, donation_id, amount, status, held_at)
       VALUES ($1, $2, $3, $4, 'held', NOW())`,
      [req.user.id, campaign_id, donationRow.id, donationAmount]
    );

    await client.query('COMMIT');

    // Send admin alert
    const adminRes = await pool.query("SELECT email FROM users WHERE role = 'admin' LIMIT 1");
    if (adminRes.rows.length > 0) {
      sendNewDonationAdminAlert({
        adminEmail: adminRes.rows[0].email,
        donorName: donor_name || req.user.name,
        amount: donationAmount,
        campaignTitle: campRes.rows[0].title,
        campaignId: campaign_id,
        paymentMethod: 'Wallet (Escrow)',
      }).catch(e => console.warn('Admin wallet donation alert failed:', e.message));
    }

    res.status(201).json({
      message: `Donation of $${donationAmount.toFixed(2)} held in escrow. Funds will be released when the campaign is completed.`,
      donation: donationRow,
      new_balance: currentBalance - donationAmount,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────
// REQUEST WITHDRAWAL
// ─────────────────────────────────────────────
const requestWithdrawal = async (req, res, next) => {
  const client = await pool.connect();

  try {
    const { amount, payment_method = 'bank', payment_details } = req.body;
    const withdrawAmount = parseFloat(amount);

    if (!withdrawAmount || withdrawAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    await client.query('BEGIN');

    const wallet = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [req.user.id]
    );

    if (wallet.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const balance = parseFloat(wallet.rows[0].balance);
    if (withdrawAmount > balance) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Insufficient balance. Available: $${balance.toFixed(2)}`,
      });
    }

    const result = await client.query(
      `INSERT INTO withdrawal_requests
       (user_id, amount, payment_method, payment_details, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [req.user.id, withdrawAmount, payment_method, payment_details || '']
    );

    await client.query('COMMIT');

    const withdrawal = result.rows[0];

    // Notify admin
    const adminRes = await pool.query("SELECT email FROM users WHERE role = 'admin' LIMIT 1");
    if (adminRes.rows.length > 0) {
      sendWithdrawalRequestAlert({
        adminEmail: adminRes.rows[0].email,
        userName: req.user.name,
        userEmail: req.user.email,
        amount: withdrawal.amount,
        withdrawalId: withdrawal.id,
      }).catch(e => console.warn('Admin withdrawal alert failed:', e.message));
    }

    res.status(201).json({
      message: 'Withdrawal request submitted. Admin will process within 24 hours.',
      request: withdrawal,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────
// GET MY WITHDRAWALS
// ─────────────────────────────────────────────
const getMyWithdrawals = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM withdrawal_requests
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ withdrawals: result.rows });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────
// ESCROW: RELEASE FUNDS TO CREATOR (admin only)
// ─────────────────────────────────────────────
const releaseEscrow = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { escrow_id } = req.params;

    await client.query('BEGIN');

    // Lock escrow hold
    const escrow = await client.query(
      'SELECT * FROM escrow_holds WHERE id = $1 AND status = $2 FOR UPDATE',
      [escrow_id, 'held']
    );

    if (escrow.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Escrow not found or already processed' });
    }

    const hold = escrow.rows[0];

    // Get campaign creator
    const campRes = await client.query(
      'SELECT creator_id, title FROM campaigns WHERE id = $1',
      [hold.campaign_id]
    );

    if (campRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const creatorId = campRes.rows[0].creator_id;

    // Credit creator wallet
    await client.query(
      `INSERT INTO wallets (user_id, balance) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + $2, updated_at = NOW()`,
      [creatorId, hold.amount]
    );

    // Record transaction for creator (using 'credit' type)
    await client.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, reference_id, description, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [creatorId, hold.amount, 'credit', hold.id, `Escrow release for "${campRes.rows[0].title}"`, 'completed']
    );

    // Update escrow status
    await client.query(
      `UPDATE escrow_holds SET status = 'released', released_at = NOW() WHERE id = $1`,
      [escrow_id]
    );

    // Update donation escrow_status
    await client.query(
      `UPDATE donations SET escrow_status = 'released' WHERE id = $1`,
      [hold.donation_id]
    );

    // Update campaign raised amount (add released amount)
    await client.query(
      `UPDATE campaigns SET raised = raised + $1, updated_at = NOW() WHERE id = $2`,
      [hold.amount, hold.campaign_id]
    );

    await client.query('COMMIT');

    res.json({ 
      success: true,
      message: 'Escrow released to campaign creator', 
      amount: hold.amount,
      campaign: campRes.rows[0].title
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────
// ESCROW: REFUND TO DONOR (admin only)
// ─────────────────────────────────────────────
const refundEscrow = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { escrow_id } = req.params;

    await client.query('BEGIN');

    const escrow = await client.query(
      'SELECT * FROM escrow_holds WHERE id = $1 AND status = $2 FOR UPDATE',
      [escrow_id, 'held']
    );

    if (escrow.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Escrow not found or already processed' });
    }

    const hold = escrow.rows[0];

    // Refund to donor wallet (donor_id is the user_id)
    await client.query(
      `INSERT INTO wallets (user_id, balance) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + $2, updated_at = NOW()`,
      [hold.donor_id, hold.amount]
    );

    // Record transaction for donor (using 'refund' type)
    await client.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, reference_id, description, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [hold.donor_id, hold.amount, 'refund', hold.id, 'Escrow refund due to campaign cancellation', 'completed']
    );

    // Update escrow status
    await client.query(
      `UPDATE escrow_holds SET status = 'refunded', released_at = NOW() WHERE id = $1`,
      [escrow_id]
    );

    // Update donation escrow_status
    await client.query(
      `UPDATE donations SET escrow_status = 'refunded' WHERE id = $1`,
      [hold.donation_id]
    );

    await client.query('COMMIT');

    res.json({ 
      success: true,
      message: 'Escrow refunded to donor wallet', 
      amount: hold.amount
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────
// GET WALLET SUMMARY (balance + recent tx + requests)
// ─────────────────────────────────────────────
const getWalletSummary = async (req, res, next) => {
  try {
    const [balRes, txRes, depRes, wdRes] = await Promise.all([
      pool.query('SELECT balance FROM wallets WHERE user_id = $1', [req.user.id]),
      pool.query(
        `SELECT * FROM wallet_transactions 
         WHERE user_id = $1 
         ORDER BY created_at DESC 
         LIMIT 20`,
        [req.user.id]
      ),
      pool.query(
        `SELECT * FROM deposit_requests 
         WHERE user_id = $1 
         ORDER BY created_at DESC 
         LIMIT 5`,
        [req.user.id]
      ),
      pool.query(
        `SELECT * FROM withdrawal_requests 
         WHERE user_id = $1 
         ORDER BY created_at DESC 
         LIMIT 5`,
        [req.user.id]
      ),
    ]);

    // Calculate total donated
    const donatedRes = await pool.query(
      `SELECT COALESCE(SUM(ABS(amount)), 0) as total_donated
       FROM wallet_transactions 
       WHERE user_id = $1 AND type IN ('donation', 'donation_out') AND status = 'completed'`,
      [req.user.id]
    );

    res.json({
      balance: parseFloat(balRes.rows[0]?.balance || 0),
      totalDonated: parseFloat(donatedRes.rows[0]?.total_donated || 0),
      transactions: txRes.rows,
      depositRequests: depRes.rows,
      withdrawals: wdRes.rows,
    });
  } catch (err) { 
    console.error('Wallet summary error:', err);
    next(err); 
  }
};

module.exports = {
  getBalance,
  getTransactions,
  requestDeposit,
  getMyDepositRequests,
  uploadProof,
  donateFromWallet,
  requestWithdrawal,
  getMyWithdrawals,
  releaseEscrow,
  refundEscrow,
  getWalletSummary,
};