const db = require("../config/db");
const { verifyPayment } = require("../utils/paypal");

// 🎯 Handle PayPal payment success
exports.handlePaymentSuccess = async (req, res) => {
  const { orderId } = req.body;

  // 🔐 Secure user from JWT
  const userId = req.user.id;

  if (!orderId) {
    return res.status(400).json({ error: "orderId is required" });
  }

  const client = await db.connect();

  try {
    // 🔍 Verify payment with PayPal
    const order = await verifyPayment(orderId);

    if (order.status !== "COMPLETED") {
      return res.status(400).json({ error: "Payment not completed" });
    }

    const purchaseUnit = order.purchase_units?.[0];

    if (!purchaseUnit) {
      return res.status(400).json({ error: "Invalid payment data" });
    }

    const amount = parseFloat(purchaseUnit.amount.value);

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    // 🚫 Prevent duplicate processing (IMPORTANT)
    const existing = await client.query(
      "SELECT id FROM wallet_transactions WHERE reference = $1",
      [orderId]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "Payment already processed" });
    }

    // 🔄 Start DB transaction
    await client.query("BEGIN");

    // 💰 Ensure wallet exists
    await client.query(
      `INSERT INTO wallets (user_id, balance)
       VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    // 💰 Credit wallet
    await client.query(
      `UPDATE wallets
       SET balance = balance + $1,
           updated_at = NOW()
       WHERE user_id = $2`,
      [amount, userId]
    );

    // 🧾 Record transaction in ledger
    await client.query(
      `INSERT INTO wallet_transactions 
       (user_id, amount, type, reference, description, status)
       VALUES ($1, $2, 'deposit', $3, 'PayPal deposit', 'completed')`,
      [userId, amount, orderId]
    );

    // ✅ Commit
    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Wallet credited successfully",
      amount,
    });

  } catch (err) {
    await client.query("ROLLBACK");

    console.error("Payment error:", err);

    return res.status(500).json({
      error: "Payment processing failed",
    });
  } finally {
    client.release();
  }
};