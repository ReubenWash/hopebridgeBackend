const router = require('express').Router()
const { body } = require('express-validator')
const {
  getAllCampaigns, getCampaign, createCampaign,
  updateCampaign, deleteCampaign, getMyCampaigns,
} = require('../controllers/campaignController')
const { authenticate, requireCreator } = require('../middleware/auth')
const { validate } = require('../middleware/errorHandler')
const upload = require('../middleware/upload')

const campaignValidation = [
  body('title').trim().notEmpty().withMessage('Title is required').isLength({ max: 200 }),
  body('goal').isFloat({ min: 10 }).withMessage('Goal must be at least $10'),
  body('category').optional().isLength({ max: 80 }),
]

// Public
router.get('/', getAllCampaigns)
router.get('/my', authenticate, requireCreator, getMyCampaigns)
router.get('/:id', getCampaign)

// Creator
router.post('/',
  authenticate, requireCreator,
  upload.single('image'),
  campaignValidation, validate,
  createCampaign
)
router.patch('/:id',
  authenticate, requireCreator,
  upload.single('image'),
  campaignValidation, validate,
  updateCampaign
)
router.delete('/:id', authenticate, requireCreator, deleteCampaign)

module.exports = router
