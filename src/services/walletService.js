const creditWallet = async (userId, amount, client) => {
  const query = `
    UPDATE wallets
    SET balance = balance + $1,
        updated_at = NOW()
    WHERE user_id = $2
    RETURNING *;
  `;

  const result = await client.query(query, [amount, userId]);

  if (result.rows.length === 0) {
    throw new Error("Wallet not found for user");
  }

  return result.rows[0];
};

module.exports = {
  creditWallet,
};