const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Log config status on startup
if (
  !process.env.CLOUDINARY_CLOUD_NAME ||
  !process.env.CLOUDINARY_API_KEY    ||
  !process.env.CLOUDINARY_API_SECRET
) {
  console.warn('⚠️  Cloudinary credentials not fully configured — image uploads will fail.');
} else {
  console.log('✅ Cloudinary configured successfully');
}

// ── Storage ───────────────────────────────────────
// ✅ Transformation removed — it added 5-15s of server-side processing
//    which was causing Koyeb's 30s gateway timeout to fire.
//    Images are stored as-is; resize on-the-fly via Cloudinary URLs if needed.
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:          'hopebridge',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],  // removed pdf — not needed for campaign images
    resource_type:   'image',
    // Unique filename to avoid collisions
    public_id: (req, file) => `${Date.now()}-${Math.round(Math.random() * 1e9)}`,
  },
});

module.exports = { cloudinary, storage };