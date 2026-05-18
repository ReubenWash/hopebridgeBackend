const ImageKit = require('@imagekit/nodejs');

// Get settings from database or environment variables
let imagekitInstance = null;

const getImageKitConfig = async () => {
  try {
    // If you want to load from database settings
    const pool = require('./db');
    const result = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('imagekit_public_key', 'imagekit_private_key', 'imagekit_url_endpoint')"
    );
    
    const config = {};
    for (const row of result.rows) {
      config[row.key] = row.value;
    }
    
    return {
      publicKey: config.imagekit_public_key || process.env.IMAGEKIT_PUBLIC_KEY,
      privateKey: config.imagekit_private_key || process.env.IMAGEKIT_PRIVATE_KEY,
      urlEndpoint: config.imagekit_url_endpoint || process.env.IMAGEKIT_URL_ENDPOINT,
    };
  } catch (err) {
    // Fallback to environment variables
    return {
      publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
      privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
      urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
    };
  }
};

const getImageKit = async () => {
  if (!imagekitInstance) {
    const config = await getImageKitConfig();
    if (config.publicKey && config.privateKey && config.urlEndpoint) {
      imagekitInstance = new ImageKit({
        publicKey: config.publicKey,
        privateKey: config.privateKey,
        urlEndpoint: config.urlEndpoint,
      });
      console.log('✅ ImageKit.io configured successfully');
    } else {
      console.warn('⚠️ ImageKit.io credentials not configured');
    }
  }
  return imagekitInstance;
};

const uploadToImageKit = async (fileBuffer, fileName, folder = 'hopebridge/campaigns') => {
  try {
    const imagekit = await getImageKit();
    if (!imagekit) {
      throw new Error('ImageKit not configured');
    }

    const result = await imagekit.upload({
      file: fileBuffer,
      fileName: fileName || `campaign-${Date.now()}.jpg`,
      folder: folder,
      useUniqueFileName: true,
      isPrivateFile: false,
    });

    console.log('✅ Image uploaded to ImageKit.io:', result.url);
    return {
      url: result.url,
      fileId: result.fileId,
      thumbnailUrl: result.thumbnailUrl,
    };
  } catch (error) {
    console.error('❌ ImageKit upload error:', error.message);
    throw new Error('Image upload failed: ' + error.message);
  }
};

const deleteFromImageKit = async (fileId) => {
  try {
    const imagekit = await getImageKit();
    if (!imagekit) {
      console.warn('ImageKit not configured, skipping delete');
      return false;
    }

    await imagekit.deleteFile(fileId);
    console.log('✅ Image deleted from ImageKit.io:', fileId);
    return true;
  } catch (error) {
    console.error('❌ ImageKit delete error:', error.message);
    return false;
  }
};

// For direct URL generation (optimized images)
const getOptimizedImageUrl = (url, options = {}) => {
  if (!url) return null;
  
  // If it's already an ImageKit URL, add transformations
  if (url.includes('ik.imagekit.io')) {
    const transformations = [];
    if (options.width) transformations.push(`w-${options.width}`);
    if (options.height) transformations.push(`h-${options.height}`);
    if (options.quality) transformations.push(`q-${options.quality}`);
    
    if (transformations.length > 0) {
      return url.replace('/tr:', `/tr:${transformations.join(',')},`);
    }
  }
  return url;
};

module.exports = { 
  getImageKit, 
  uploadToImageKit, 
  deleteFromImageKit,
  getOptimizedImageUrl 
};