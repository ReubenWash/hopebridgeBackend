// config/imagekit.js
const ImageKit = require('@imagekit/nodejs');

let imagekitInstance = null;

const getImageKit = () => {
  // First try environment variables
  const publicKey = process.env.IMAGEKIT_PUBLIC_KEY;
  const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
  const urlEndpoint = process.env.IMAGEKIT_URL_ENDPOINT;
  
  console.log('🔧 ImageKit Config Check:');
  console.log('   PUBLIC_KEY:', publicKey ? `${publicKey.substring(0, 10)}...` : '❌ MISSING');
  console.log('   PRIVATE_KEY:', privateKey ? `${privateKey.substring(0, 10)}...` : '❌ MISSING');
  console.log('   URL_ENDPOINT:', urlEndpoint || '❌ MISSING');
  
  if (!publicKey || !privateKey || !urlEndpoint) {
    console.error('❌ ImageKit credentials missing from environment variables');
    return null;
  }
  
  if (!imagekitInstance) {
    imagekitInstance = new ImageKit({
      publicKey,
      privateKey,
      urlEndpoint,
    });
    console.log('✅ ImageKit.io initialized successfully');
  }
  
  return imagekitInstance;
};

const uploadToImageKit = async (fileBuffer, fileName, folder = 'hopebridge/campaigns') => {
  const imagekit = getImageKit();
  if (!imagekit) {
    throw new Error('ImageKit not configured - check your environment variables');
  }
  
  try {
    console.log(`📤 Uploading to ImageKit: ${fileName} (${fileBuffer.length} bytes)`);
    const result = await imagekit.upload({
      file: fileBuffer,
      fileName: fileName,
      folder: folder,
      useUniqueFileName: true,
    });
    console.log('✅ ImageKit upload successful:', result.url);
    return result;
  } catch (error) {
    console.error('❌ ImageKit upload error:', error.message);
    throw error;
  }
};

const deleteFromImageKit = async (fileId) => {
  const imagekit = getImageKit();
  if (!imagekit) return false;
  
  try {
    await imagekit.deleteFile(fileId);
    console.log('✅ Image deleted from ImageKit:', fileId);
    return true;
  } catch (error) {
    console.error('❌ ImageKit delete error:', error.message);
    return false;
  }
};

module.exports = { getImageKit, uploadToImageKit, deleteFromImageKit };