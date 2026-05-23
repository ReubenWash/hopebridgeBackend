const admin = require('firebase-admin');

let firebaseApp = null;
let initialized = false;

const initFirebase = () => {
  try {
    // Try to get service account from environment variable
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    
    if (serviceAccountJson) {
      const serviceAccount = JSON.parse(serviceAccountJson);
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log('✅ Firebase Admin SDK initialized with service account');
      initialized = true;
      return;
    }
    
    // Fallback to legacy FCM server key (less secure, but works)
    const serverKey = process.env.FIREBASE_SERVER_KEY;
    if (serverKey) {
      console.log('⚠️ Using legacy FCM server key (less secure)');
      initialized = true;
      return;
    }
    
    console.warn('⚠️ Firebase credentials not found - push notifications disabled');
  } catch (err) {
    console.error('❌ Firebase initialization failed:', err.message);
  }
};

const getMessaging = () => {
  if (!initialized) return null;
  if (firebaseApp) return admin.messaging(firebaseApp);
  return null;
};

// Legacy FCM send using server key (fallback)
const sendLegacyFCM = async (tokens, notification, data = {}) => {
  const serverKey = process.env.FIREBASE_SERVER_KEY;
  if (!serverKey) throw new Error('Firebase server key not configured');
  
  const fetch = require('node-fetch');
  const response = await fetch('https://fcm.googleapis.com/fcm/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `key=${serverKey}`,
    },
    body: JSON.stringify({
      registration_ids: Array.isArray(tokens) ? tokens : [tokens],
      notification: {
        title: notification.title,
        body: notification.body,
        icon: notification.icon || '/logo192.png',
        click_action: notification.click_action || '/',
      },
      data: data,
      priority: 'high',
    }),
  });
  
  return response.json();
};

// Modern FCM send using Firebase Admin SDK
const sendModernFCM = async (tokens, notification, data = {}) => {
  const messaging = getMessaging();
  if (!messaging) throw new Error('Firebase messaging not initialized');
  
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
        icon: notification.icon || '/logo192.png',
        badge: '/badge.png',
        vibrate: [200, 100, 200],
        requireInteraction: true,
      },
    },
  };
  
  // Send to multiple tokens
  if (Array.isArray(tokens) && tokens.length > 1) {
    const response = await messaging.sendEachForMulticast({
      ...message,
      tokens: tokens,
    });
    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
      responses: response.responses,
    };
  }
  
  // Send to single token
  const singleToken = Array.isArray(tokens) ? tokens[0] : tokens;
  const response = await messaging.send({
    ...message,
    token: singleToken,
  });
  
  return { successCount: 1, failureCount: 0, messageId: response };
};

const sendPushNotification = async (tokens, notification, data = {}) => {
  if (!tokens || tokens.length === 0) {
    return { successCount: 0, failureCount: 0, message: 'No tokens provided' };
  }
  
  const tokensArray = Array.isArray(tokens) ? tokens : [tokens];
  
  try {
    // Try modern FCM first
    if (initialized && firebaseApp) {
      return await sendModernFCM(tokensArray, notification, data);
    }
    // Fallback to legacy
    return await sendLegacyFCM(tokensArray, notification, data);
  } catch (err) {
    console.error('FCM send error:', err.message);
    // Try legacy as fallback
    try {
      return await sendLegacyFCM(tokensArray, notification, data);
    } catch (fallbackErr) {
      console.error('Legacy FCM also failed:', fallbackErr.message);
      return { successCount: 0, failureCount: tokensArray.length, error: err.message };
    }
  }
};

// Create notification channels (for Android)
const createNotificationChannel = async () => {
  const messaging = getMessaging();
  if (!messaging) return;
  
  // Android channel creation is handled client-side
  console.log('📱 Android notification channels should be created on client side');
};

// Send notification to a specific user by ID
const sendToUser = async (userId, notification, data = {}) => {
  const pool = require('./db');
  const result = await pool.query('SELECT fcm_token FROM users WHERE id = $1 AND fcm_token IS NOT NULL', [userId]);
  
  if (result.rows.length === 0) {
    return { successCount: 0, failureCount: 0, message: 'User has no FCM token' };
  }
  
  return await sendPushNotification(result.rows[0].fcm_token, notification, data);
};

// Send notification to all users with a specific role
const sendToRole = async (role, notification, data = {}) => {
  const pool = require('./db');
  const result = await pool.query(
    'SELECT fcm_token FROM users WHERE role = $1 AND fcm_token IS NOT NULL',
    [role]
  );
  
  const tokens = result.rows.map(r => r.fcm_token);
  return await sendPushNotification(tokens, notification, data);
};

// Send notification to all users
const sendToAll = async (notification, data = {}) => {
  const pool = require('./db');
  const result = await pool.query('SELECT fcm_token FROM users WHERE fcm_token IS NOT NULL');
  
  const tokens = result.rows.map(r => r.fcm_token);
  return await sendPushNotification(tokens, notification, data);
};

// Send notification to admins only
const sendToAdmins = async (notification, data = {}) => {
  const pool = require('./db');
  const result = await pool.query(
    'SELECT fcm_token FROM users WHERE role = $1 AND fcm_token IS NOT NULL',
    ['admin']
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
  createNotificationChannel,
};