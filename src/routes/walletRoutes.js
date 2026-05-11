const router = require("express").Router();
const { body } = require("express-validator");

const {
  requestWithdrawal,
  getMyWithdrawals,
  updateWithdrawalStatus,
} = require("../controllers/walletController");

const { authenticate, requireAdmin } = require("../middleware/auth");
const { validate } = require("../middleware/errorHandler");


// 💰 Request withdrawal
router.post(
  "/withdraw",
  authenticate,
  [
    body("amount").isFloat({ min: 1 }),
    body("payment_method").optional().isString(),
    body("payment_details").optional().isString(),
  ],
  validate,
  requestWithdrawal
);


// 📄 User withdrawals
router.get("/withdraw/my", authenticate, getMyWithdrawals);


// 🛠️ Admin action
router.put(
  "/withdraw/:id",
  authenticate,
  requireAdmin,
  [
    body("status").isIn(["approved", "paid", "rejected"]),
  ],
  validate,
  updateWithdrawalStatus
);


module.exports = router;