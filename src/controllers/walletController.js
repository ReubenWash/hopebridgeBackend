const pool = require('../config/db');
const {
  sendNewDepositRequestAlert,
  sendNewDonationAdminAlert,
  sendWithdrawalRequestAlert,
} = require('../utils/email');

// 🏦 Get wallet balance
const getBalance = async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      await pool.query(
        'INSERT INTO wallets (user_id, balance) VALUES ($1, 0)',
        [req.user.id]
      );
      return res.json({ balance: 0 });
    }

    res.json({ balance: parseFloat(result.rows[0].balance) });
  } catch (err) {
    next(err);
  }
};

// 📜 Get transaction history
const getTransactions = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM wallet_transactions 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 50`,
      [req.user.id]
    );

    res.json({ transactions: result.rows });
  } catch (err) {
    next(err);
  }
};

// 💰 Request deposit (manual / admin flow)
const requestDeposit = async (req, res, next) => {
  try {
    const { amount } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).json({ error: 'Amount must be at least $1' });
    }

    const result = await pool.query(
      `INSERT INTO deposit_requests (user_id, amount, status)
       VALUES ($1, $2, 'pending') RETURNING *`,
      [req.user.id, amount]
    );

    const request = result.rows[0];

    // 🔔 Send admin alert
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
      message: 'Deposit request created. Awaiting admin instructions.',
      request,
    });
  } catch (err) {
    next(err);
  }
};

// 📄 Get my deposit requests
const getMyDepositRequests = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM deposit_requests 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    res.json({ requests: result.rows });
  } catch (err) {
    next(err);
  }
};

// 📤 Upload payment proof
const uploadProof = async (req, res, next) => {
  try {
    const { requestId } = req.params;

    const proofImageUrl = req.file
      ? `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`
      : req.body.proof_image_url;

    if (!proofImageUrl) {
      return res.status(400).json({ error: 'Proof image is required' });
    }

    const result = await pool.query(
      `UPDATE deposit_requests 
       SET proof_image_url = $1, status = 'awaiting_proof'
       WHERE id = $2 AND user_id = $3 AND status = 'pending'
       RETURNING *`,
      [proofImageUrl, requestId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Request not found or already processed',
      });
    }

    res.json({
      message: 'Proof uploaded. Admin will verify.',
      request: result.rows[0],
    });
  } catch (err) {
    next(err);
  }
};

// ❤️ Donate from wallet
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

    if (!campaign_id || !amount || amount <= 0) {
      return res.status(400).json({
        error: 'Valid campaign and amount required',
      });
    }

    await client.query('BEGIN');

    // 🔒 Lock wallet row
    const wallet = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [req.user.id]
    );

    if (wallet.rows.length === 0) {
      throw new Error('Wallet not found');
    }

    const currentBalance = parseFloat(wallet.rows[0].balance);

    if (currentBalance < amount) {
      return res.status(400).json({
        error: 'Insufficient wallet balance',
      });
    }

    // 💸 Deduct balance
    await client.query(
      'UPDATE wallets SET balance = balance - $1 WHERE user_id = $2',
      [amount, req.user.id]
    );

    // 🎁 Create donation
    const donation = await client.query(
      `INSERT INTO donations 
       (campaign_id, donor_name, donor_email, amount, message, is_monthly, payment_method)
       VALUES ($1, $2, $3, $4, $5, $6, 'wallet')
       RETURNING *`,
      [
        campaign_id,
        donor_name || req.user.name,
        donor_email || req.user.email,
        amount,
        message || '',
        is_monthly || false,
      ]
    );

    // 📊 Update campaign total
    await client.query(
      `UPDATE campaigns 
       SET raised = (
         SELECT COALESCE(SUM(amount), 0) 
         FROM donations 
         WHERE campaign_id = $1
       )
       WHERE id = $1`,
      [campaign_id]
    );

    // 🧾 Ledger record
    await client.query(
      `INSERT INTO wallet_transactions 
       (user_id, amount, type, reference_id, description)
       VALUES ($1, $2, 'donation_out', $3, $4)`,
      [
        req.user.id,
        amount,
        donation.rows[0].id,
        `Donation to campaign #${campaign_id}`,
      ]
    );

    // Get campaign title for admin email
    const campRes = await client.query(
      'SELECT title FROM campaigns WHERE id = $1',
      [campaign_id]
    );
    const campaignTitle = campRes.rows[0]?.title || 'Unknown Campaign';

    await client.query('COMMIT');

    // 🔔 Send admin alert (wallet donation)
    const adminRes = await pool.query("SELECT email FROM users WHERE role = 'admin' LIMIT 1");
    if (adminRes.rows.length > 0) {
      sendNewDonationAdminAlert({
        adminEmail: adminRes.rows[0].email,
        donorName: donor_name || req.user.name,
        amount,
        campaignTitle,
        campaignId: campaign_id,
        paymentMethod: 'Wallet',
      }).catch(e => console.warn('Admin wallet donation alert email failed:', e.message));
    }

    res.status(201).json({
      message: `Donation of $${amount} completed from wallet`,
      donation: donation.rows[0],
      new_balance: currentBalance - amount,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// 💸 REQUEST WITHDRAWAL
const requestWithdrawal = async (req, res, next) => {
  const client = await pool.connect();

  try {
    const { amount, payment_method, payment_details } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    await client.query('BEGIN');

    const wallet = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [req.user.id]
    );

    if (wallet.rows.length === 0) {
      throw new Error('Wallet not found');
    }

    const balance = parseFloat(wallet.rows[0].balance);

    if (amount > balance) {
      return res.status(400).json({
        error: 'Insufficient balance',
      });
    }

    const result = await client.query(
      `INSERT INTO withdrawal_requests 
       (user_id, amount, payment_method, payment_details)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        req.user.id,
        amount,
        payment_method || 'paypal',
        payment_details || '',
      ]
    );

    await client.query('COMMIT');

    const withdrawal = result.rows[0];

    // 🔔 Send admin alert for withdrawal request
    const adminRes = await pool.query("SELECT email FROM users WHERE role = 'admin' LIMIT 1");
    if (adminRes.rows.length > 0) {
      sendWithdrawalRequestAlert({
        adminEmail: adminRes.rows[0].email,
        userName: req.user.name,
        userEmail: req.user.email,
        amount: withdrawal.amount,
        withdrawalId: withdrawal.id,
      }).catch(e => console.warn('Admin withdrawal alert email failed:', e.message));
    }

    res.json({
      message: 'Withdrawal request submitted',
      request: withdrawal,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// 📄 GET MY WITHDRAWALS
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

module.exports = {
  getBalance,
  getTransactions,
  requestDeposit,
  getMyDepositRequests,
  uploadProof,
  donateFromWallet,
  requestWithdrawal,
  getMyWithdrawals,
};