const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;

// ── Cloudinary config ────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const isCloudinaryConfigured = () => {
  const ok =
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET;
  if (!ok) {
    console.warn(
      '⚠️  Cloudinary not fully configured – falling back to local disk storage.\n' +
      '   Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET to enable cloud uploads.'
    );
  } else {
    console.log('✅ Cloudinary configured successfully');
  }
  return !!ok;
};

// ── Storage ──────────────────────────────────────────────────────────────────
let storage;

if (isCloudinaryConfigured()) {
  // Safe require inside the if-block so a missing package never crashes startup
  let CloudinaryStorage;
  try {
    ({ CloudinaryStorage } = require('multer-storage-cloudinary'));
  } catch (e) {
    console.error('❌ multer-storage-cloudinary not installed:', e.message);
    console.warn('   Run: npm install multer-storage-cloudinary');
    process.exit(1);
  }

  storage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
      let folder = 'hopebridge';
      if (req.originalUrl.includes('/campaigns')) {
        folder = 'hopebridge/campaigns';
      } else if (
        req.originalUrl.includes('/deposit-request') &&
        req.originalUrl.includes('/proof')
      ) {
        folder = 'hopebridge/deposit-proofs';
      }

      const timestamp = Date.now();
      const random    = Math.round(Math.random() * 1e9);

      return {
        folder,
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
        transformation: [
          { width: 1200, height: 1200, crop: 'limit', quality: 'auto' },
        ],
        public_id: `${timestamp}-${random}`,
      };
    },
  });
} else {
  // ── Local disk fallback ────────────────────────────────────────────────────
  const fs        = require('fs');
  const uploadDir = process.env.UPLOAD_DIR || 'uploads';
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${uuidv4()}${ext}`);
    },
  });
}

// ── File filter ──────────────────────────────────────────────────────────────
const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'application/pdf',
  ];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPG, PNG, WebP images, and PDF files are allowed.'));
  }
};

// ── Multer instance ──────────────────────────────────────────────────────────
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

module.exports = upload;