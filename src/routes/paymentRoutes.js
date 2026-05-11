const express = require("express");
const router = express.Router();
const paymentController = require("../controllers/paymentController");

router.post("/verify", paymentController.handlePaymentSuccess);

module.exports = router;