// DEPRECATED: PayPal is no longer supported.
// Wallet deposits now go through the deposit request flow (admin approval).
// This file is kept for reference but all endpoints should return 410 Gone.

const handlePaymentSuccess = async (req, res) => {
  return res.status(410).json({
    error: 'PayPal deposits are no longer supported. Please use the deposit request system: POST /api/wallet/deposit-request'
  });
};

module.exports = {
  handlePaymentSuccess
};