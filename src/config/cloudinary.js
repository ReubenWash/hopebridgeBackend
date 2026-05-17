const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

if (
  !process.env.CLOUDINARY_CLOUD_NAME ||
  !process.env.CLOUDINARY_API_KEY    ||
  !process.env.CLOUDINARY_API_SECRET
) {
  console.warn('⚠️  Cloudinary credentials not fully configured — image uploads will fail.');
} else {
  console.log('✅ Cloudinary configured successfully');
}

// ── Cloudinary storage ────────────────────────────
// No transformation applied on upload — keeps it fast.
// If you need resizing, use Cloudinary URL params instead:
// e.g. image_url.replace('/upload/', '/upload/w_800,c_limit/')
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder:          'hopebridge',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    resource_type:   'image',
    public_id:       `${Date.now()}-${Math.round(Math.random() * 1e9)}`,
  }),
});

// ── Multer with 5MB limit ─────────────────────────
// Rejects oversized files before hitting Cloudinary,
// preventing timeouts on large uploads.
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG, and WebP images are allowed.'));
    }
  },
});

module.exports = { cloudinary, storage, upload };