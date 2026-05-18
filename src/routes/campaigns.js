const router = require('express').Router()
const { body } = require('express-validator')
const {
  getAllCampaigns, 
  getCampaign,
  getCampaignUpdates,
  addCampaignUpdate,
  getRelatedCampaigns,
  createCampaign,
  updateCampaign, 
  deleteCampaign, 
  getMyCampaigns,
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

const updateValidation = [
  body('title').optional().trim().isLength({ max: 200 }),
  body('title').optional().notEmpty().withMessage('Title cannot be empty'),
  body('goal').optional().isFloat({ min: 10 }).withMessage('Goal must be at least $10'),
]

// ── Upload with timeout ───────────────────────────
const uploadWithTimeout = (req, res, next) => {
  const timer = setTimeout(() => {
    next(new Error('Image upload timed out. Please use a JPG or PNG under 5MB.'))
  }, 28000)

  upload.single('image')(req, res, (err) => {
    clearTimeout(timer)
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new Error('Image too large. Please use a file under 5MB.'))
      }
      return next(err)
    }
    next()
  })
}

// ── Public ───────────────────────────────────────
router.get('/', getAllCampaigns)
router.get('/my', authenticate, requireCreator, getMyCampaigns)
router.get('/:id', getCampaign)
router.get('/:id/updates', getCampaignUpdates)
router.get('/:id/related', getRelatedCampaigns)

// ── Creator ──────────────────────────────────────
router.post('/',
  authenticate, requireCreator,
  uploadWithTimeout,
  campaignValidation, validate,
  createCampaign
)

router.post('/:id/updates',
  authenticate, requireCreator,
  [
    body('title').trim().notEmpty().withMessage('Title is required'),
    body('content').trim().notEmpty().withMessage('Content is required'),
  ],
  validate,
  addCampaignUpdate
)

router.patch('/:id',
  authenticate, requireCreator,
  uploadWithTimeout,
  updateValidation, validate,
  updateCampaign
)

router.delete('/:id', authenticate, requireCreator, deleteCampaign)

// Creator requests escrow release
router.post('/:id/complete-request', authenticate, requireCreator, requestCampaignCompletion)

module.exports = router