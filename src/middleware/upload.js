const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('cloudinary').v2;

// Cloudinary configuration (should be set in environment variables)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Check if Cloudinary is properly configured
const isCloudinaryConfigured = () => {
  const configured = process.env.CLOUDINARY_CLOUD_NAME && 
                    process.env.CLOUDINARY_API_KEY && 
                    process.env.CLOUDINARY_API_SECRET;
  if (!configured) {
    console.warn('⚠️ Cloudinary credentials not fully configured. Uploads will fail. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET');
  } else {
    console.log('✅ Cloudinary configured successfully');
  }
  return configured;
};
isCloudinaryConfigured();

// Configure Cloudinary storage
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    // Determine folder based on file purpose
    let folder = 'hopebridge';
    
    // Check if this is a campaign image or deposit proof
    if (req.originalUrl.includes('/campaigns')) {
      folder = 'hopebridge/campaigns';
    } else if (req.originalUrl.includes('/deposit-request') && req.originalUrl.includes('/proof')) {
      folder = 'hopebridge/deposit-proofs';
    }
    
    // Generate unique filename
    const timestamp = Date.now();
    const random = Math.round(Math.random() * 1e9);
    
    return {
      folder: folder,
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
      transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }],
      public_id: `${timestamp}-${random}`,
    };
  },
});

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPG, PNG, WebP images, and PDF files are allowed.'));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max (proofs might be larger)
});

module.exports = upload;