// config/imagekit.js
const ImageKit = require('imagekit'); // ✅ use 'imagekit' not '@imagekit/nodejs'

let imagekitInstance = null;

const getImageKit = () => {
  const publicKey  = process.env.IMAGEKIT_PUBLIC_KEY;
  const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
  const urlEndpoint = process.env.IMAGEKIT_URL_ENDPOINT;

  if (!publicKey || !privateKey || !urlEndpoint) {
    console.error('❌ ImageKit credentials missing from environment variables');
    return null;
  }

  if (!imagekitInstance) {
    imagekitInstance = new ImageKit({ publicKey, privateKey, urlEndpoint });
    console.log('✅ ImageKit initialized successfully');
  }

  return imagekitInstance;
};

// ── Upload ────────────────────────────────────────
const uploadToImageKit = async (fileBuffer, fileName, folder = 'hopebridge/campaigns') => {
  const imagekit = getImageKit();
  if (!imagekit) throw new Error('ImageKit not configured — check environment variables');

  console.log(`📤 Uploading to ImageKit: ${fileName} (${fileBuffer.length} bytes)`);

  // ✅ 'imagekit' package: file must be base64 string or URL, not raw Buffer
  const base64File = fileBuffer.toString('base64');

  const result = await imagekit.upload({
    file:            base64File,
    fileName:        fileName,
    folder:          folder,
    useUniqueFileName: true,
  });

  console.log('✅ ImageKit upload successful:', result.url);
  return result;
};

// ── Delete ────────────────────────────────────────
const deleteFromImageKit = async (fileId) => {
  const imagekit = getImageKit();
  if (!imagekit) return false;

  try {
    await imagekit.deleteFile(fileId);
    console.log('✅ Image deleted from ImageKit:', fileId);
    return true;
  } catch (err) {
    console.error('❌ ImageKit delete error:', err.message);
    return false;
  }
};

module.exports = { getImageKit, uploadToImageKit, deleteFromImageKit };