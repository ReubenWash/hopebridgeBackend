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
  // For multer-storage-cloudinary v2.x - different import syntax
  const cloudinaryStorage = require('multer-storage-cloudinary');
  
  // v2.x uses createCloudinaryStorage or the default export
  const CloudinaryStorage = cloudinaryStorage.CloudinaryStorage || cloudinaryStorage;
  
  storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    folder: 'hopebridge',
    allowedFormats: ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
    transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }],
    filename: (req, file) => {
      const timestamp = Date.now();
      const random = Math.round(Math.random() * 1e9);
      return `${timestamp}-${random}`;
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