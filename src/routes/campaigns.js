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
const pool = require('../config/db')
const { uploadToImageKit, deleteFromImageKit } = require('../config/imagekit')

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

// ── Configure multer for gallery images (multiple files) ──
const galleryUpload = upload.array('gallery_images', 10)

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

// ── Creator Gallery Management (NEW) ──────────────────────────────

// GET campaign with gallery images
router.get('/creator/:id', authenticate, requireCreator, async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Get campaign (ensure it belongs to the creator)
    const campaignResult = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1 AND creator_id = $2',
      [id, req.user.id]
    );
    
    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    // Get gallery images
    const galleryResult = await pool.query(
      'SELECT id, image_url, image_file_id, position FROM campaign_gallery WHERE campaign_id = $1 ORDER BY position ASC, created_at ASC',
      [id]
    );
    
    res.json({
      campaign: {
        ...campaignResult.rows[0],
        gallery_images: galleryResult.rows
      }
    });
  } catch (err) {
    next(err);
  }
});

// POST add gallery images to campaign
router.post('/:id/gallery',
  authenticate, requireCreator,
  (req, res, next) => {
    galleryUpload(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'Image too large. Please use files under 5MB.' });
        }
        return next(err);
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      const { id } = req.params;
      
      // Verify campaign belongs to creator
      const campaignCheck = await pool.query(
        'SELECT id FROM campaigns WHERE id = $1 AND creator_id = $2',
        [id, req.user.id]
      );
      
      if (campaignCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No images provided' });
      }
      
      // Get current max position
      const positionResult = await pool.query(
        'SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM campaign_gallery WHERE campaign_id = $1',
        [id]
      );
      let nextPosition = positionResult.rows[0].next_pos || 0;
      
      const uploadedImages = [];
      
      for (const file of req.files) {
        try {
          const fileName = `gallery-${id}-${Date.now()}-${Math.random().toString(36).substr(2, 6)}.jpg`;
          const uploadResult = await uploadToImageKit(file.buffer, fileName, 'hopebridge/gallery');
          
          if (uploadResult && uploadResult.url) {
            const result = await pool.query(
              `INSERT INTO campaign_gallery (campaign_id, image_url, image_file_id, position)
               VALUES ($1, $2, $3, $4)
               RETURNING id, image_url, position`,
              [id, uploadResult.url, uploadResult.fileId, nextPosition++]
            );
            uploadedImages.push(result.rows[0]);
          }
        } catch (uploadErr) {
          console.error('Gallery upload error for file:', file.originalname, uploadErr.message);
          // Continue with other files
        }
      }
      
      res.json({
        success: true,
        message: `${uploadedImages.length} image(s) added to gallery`,
        images: uploadedImages
      });
    } catch (err) {
      console.error('Gallery upload error:', err);
      next(err);
    }
  }
);

// DELETE remove a gallery image
router.delete('/:id/gallery/:imageId',
  authenticate, requireCreator,
  async (req, res, next) => {
    try {
      const { id, imageId } = req.params;
      
      // Verify campaign belongs to creator
      const campaignCheck = await pool.query(
        'SELECT id FROM campaigns WHERE id = $1 AND creator_id = $2',
        [id, req.user.id]
      );
      
      if (campaignCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      
      // Get image info
      const imageResult = await pool.query(
        'SELECT image_file_id FROM campaign_gallery WHERE id = $1 AND campaign_id = $2',
        [imageId, id]
      );
      
      if (imageResult.rows.length === 0) {
        return res.status(404).json({ error: 'Gallery image not found' });
      }
      
      // Delete from ImageKit
      if (imageResult.rows[0].image_file_id) {
        try {
          await deleteFromImageKit(imageResult.rows[0].image_file_id);
        } catch (deleteErr) {
          console.warn('Failed to delete from ImageKit:', deleteErr.message);
        }
      }
      
      // Delete from database
      await pool.query('DELETE FROM campaign_gallery WHERE id = $1', [imageId]);
      
      // Reorder remaining images
      await pool.query(`
        UPDATE campaign_gallery 
        SET position = sub.new_position
        FROM (
          SELECT id, ROW_NUMBER() OVER (ORDER BY position, created_at) - 1 as new_position
          FROM campaign_gallery 
          WHERE campaign_id = $1
        ) sub
        WHERE campaign_gallery.id = sub.id
      `, [id]);
      
      res.json({
        success: true,
        message: 'Gallery image removed successfully'
      });
    } catch (err) {
      console.error('Delete gallery image error:', err);
      next(err);
    }
  }
);

// PATCH reorder gallery images
router.patch('/:id/gallery/reorder',
  authenticate, requireCreator,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { imageOrder } = req.body; // Array of image IDs in desired order
      
      // Verify campaign belongs to creator
      const campaignCheck = await pool.query(
        'SELECT id FROM campaigns WHERE id = $1 AND creator_id = $2',
        [id, req.user.id]
      );
      
      if (campaignCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      
      if (!imageOrder || !Array.isArray(imageOrder)) {
        return res.status(400).json({ error: 'Invalid image order' });
      }
      
      // Update positions
      for (let i = 0; i < imageOrder.length; i++) {
        await pool.query(
          'UPDATE campaign_gallery SET position = $1 WHERE id = $2 AND campaign_id = $3',
          [i, imageOrder[i], id]
        );
      }
      
      res.json({
        success: true,
        message: 'Gallery reordered successfully'
      });
    } catch (err) {
      console.error('Reorder gallery error:', err);
      next(err);
    }
  }
);

module.exports = router;