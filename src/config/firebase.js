const admin = require('firebase-admin');

let messaging = null;
let initialized = false;

const initFirebase = () => {
  try {
    // Check if already initialized
    if (admin.apps.length > 0) {
      console.log('✅ Firebase already initialized');
      initialized = true;
      messaging = admin.messaging();
      return;
    }

    // Try to get service account from environment variable
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    
    if (serviceAccountJson) {
      const serviceAccount = JSON.parse(serviceAccountJson);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log('✅ Firebase Admin SDK initialized with service account');
      initialized = true;
      messaging = admin.messaging();
      return;
    }
    
    // Fallback: Try to use default credentials (for Google Cloud environments)
    try {
      admin.initializeApp();
      console.log('✅ Firebase Admin SDK initialized with default credentials');
      initialized = true;
      messaging = admin.messaging();
      return;
    } catch (fallbackErr) {
      console.warn('⚠️ Default credentials not available');
    }
    
    console.warn('⚠️ Firebase credentials not found - push notifications disabled');
    initialized = false;
    
  } catch (err) {
    console.error('❌ Firebase initialization failed:', err.message);
    initialized = false;
  }
};

const getMessaging = () => {
  if (!initialized) return null;
  return messaging;
};

// Modern FCM send using Firebase Admin SDK (HTTP v1 API)
const sendPushNotification = async (tokens, notification, data = {}) => {
  if (!initialized) {
    console.warn('⚠️ Firebase not initialized - cannot send notification');
    return { successCount: 0, failureCount: tokens?.length || 0, error: 'Firebase not initialized' };
  }
  
  if (!tokens || tokens.length === 0) {
    console.log('No tokens provided, skipping notification');
    return { successCount: 0, failureCount: 0, message: 'No tokens provided' };
  }
  
  const tokensArray = Array.isArray(tokens) ? tokens : [tokens];
  const validTokens = tokensArray.filter(t => t && t.length > 10);
  
  if (validTokens.length === 0) {
    console.log('No valid tokens found');
    return { successCount: 0, failureCount: tokensArray.length, message: 'No valid tokens' };
  }
  
  try {
    const message = {
      notification: {
        title: notification.title,
        body: notification.body,
        imageUrl: notification.imageUrl,
      },
      data: data,
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'hopebridge_notifications',
          icon: 'ic_notification',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
      webpush: {
        headers: {
          Urgency: 'high',
        },
        notification: {
          icon: notification.icon || '/icons/icon-192x192.png',
          badge: '/icons/badge.png',
          vibrate: [200, 100, 200],
          requireInteraction: true,
        },
      },
    };
    
    let result;
    
    // Send to multiple tokens (up to 500 at once)
    if (validTokens.length > 1) {
      result = await messaging.sendEachForMulticast({
        ...message,
        tokens: validTokens,
      });
      
      console.log(`📱 FCM sent to ${result.successCount}/${validTokens.length} devices`);
      
      // Clean up invalid tokens
      if (result.failureCount > 0) {
        const invalidTokens = [];
        result.responses.forEach((resp, idx) => {
          if (!resp.success) {
            invalidTokens.push(validTokens[idx]);
          }
        });
        if (invalidTokens.length > 0) {
          await cleanupInvalidTokens(invalidTokens);
        }
      }
      
      return {
        successCount: result.successCount,
        failureCount: result.failureCount,
        responses: result.responses,
      };
    }
    
    // Send to single token
    result = await messaging.send({
      ...message,
      token: validTokens[0],
    });
    
    return {
      successCount: 1,
      failureCount: 0,
      messageId: result,
    };
    
  } catch (err) {
    console.error('FCM send error:', err.message);
    return { successCount: 0, failureCount: tokensArray.length, error: err.message };
  }
};

// Clean up invalid tokens from database
const cleanupInvalidTokens = async (invalidTokens) => {
  const pool = require('./db');
  for (const token of invalidTokens) {
    try {
      await pool.query(
        "UPDATE users SET fcm_token = NULL WHERE fcm_token = $1",
        [token]
      );
      console.log('🗑️ Removed invalid FCM token from database');
    } catch (err) {
      console.warn('Failed to clean up invalid token:', err.message);
    }
  }
};

// Send notification to a specific user by ID
const sendToUser = async (userId, notification, data = {}) => {
  const pool = require('./db');
  const result = await pool.query(
    'SELECT fcm_token FROM users WHERE id = $1 AND fcm_token IS NOT NULL',
    [userId]
  );
  
  if (result.rows.length === 0) {
    return { successCount: 0, failureCount: 0, message: 'User has no FCM token' };
  }
  
  return await sendPushNotification(result.rows[0].fcm_token, notification, data);
};

// Send notification to all users with a specific role
const sendToRole = async (role, notification, data = {}) => {
  const pool = require('./db');
  const result = await pool.query(
    "SELECT fcm_token FROM users WHERE role = $1 AND fcm_token IS NOT NULL",
    [role]
  );
  
  const tokens = result.rows.map(r => r.fcm_token);
  return await sendPushNotification(tokens, notification, data);
};

// Send notification to all users
const sendToAll = async (notification, data = {}) => {
  const pool = require('./db');
  const result = await pool.query(
    "SELECT fcm_token FROM users WHERE fcm_token IS NOT NULL"
  );
  
  const tokens = result.rows.map(r => r.fcm_token);
  return await sendPushNotification(tokens, notification, data);
};

// Send notification to admins only
const sendToAdmins = async (notification, data = {}) => {
  const pool = require('./db');
  const result = await pool.query(
    "SELECT fcm_token FROM users WHERE role = 'admin' AND fcm_token IS NOT NULL"
  );
  
  const tokens = result.rows.map(r => r.fcm_token);
  return await sendPushNotification(tokens, notification, data);
};

module.exports = {
  initFirebase,
  getMessaging,
  sendPushNotification,
  sendToUser,
  sendToRole,
  sendToAll,
  sendToAdmins,
};