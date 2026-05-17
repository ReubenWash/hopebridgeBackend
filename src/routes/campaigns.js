const router = require('express').Router()
const { body } = require('express-validator')
const {
  getAllCampaigns, getCampaign, createCampaign,
  updateCampaign, deleteCampaign, getMyCampaigns,
  requestCampaignCompletion,
} = require('../controllers/campaignController')
const { authenticate, requireCreator } = require('../middleware/auth')
const { validate } = require('../middleware/errorHandler')
const upload = require('../middleware/upload')

const campaignValidation = [
  body('title').trim().notEmpty().withMessage('Title is required').isLength({ max: 200 }),
  body('goal').isFloat({ min: 10 }).withMessage('Goal must be at least $10'),
  body('category').optional().isLength({ max: 80 }),
]

// ── Upload with timeout ───────────────────────────
// Koyeb free tier kills requests after ~30s.
// This wrapper times out at 25s and returns a clean error
// instead of letting the gateway silently 504.
const uploadWithTimeout = (req, res, next) => {
  const timer = setTimeout(() => {
    next(new Error('Image upload timed out. Please try a smaller image (under 2MB).'))
  }, 25000)

  upload.single('image')(req, res, (err) => {
    clearTimeout(timer)
    if (err) return next(err)
    next()
  })
}

// ── Public ───────────────────────────────────────
router.get('/',    getAllCampaigns)
router.get('/my',  authenticate, requireCreator, getMyCampaigns)
router.get('/:id', getCampaign)

// ── Creator ──────────────────────────────────────
router.post('/',
  authenticate, requireCreator,
  uploadWithTimeout,
  campaignValidation, validate,
  createCampaign
)

router.patch('/:id',
  authenticate, requireCreator,
  uploadWithTimeout,
  campaignValidation, validate,
  updateCampaign
)

router.delete('/:id', authenticate, requireCreator, deleteCampaign)

// Creator requests escrow release
router.post('/:id/complete-request', authenticate, requireCreator, requestCampaignCompletion)

module.exports = router