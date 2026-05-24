const router = require('express').Router()
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const { requireAdmin } = require('../middleware/auth')
const pool = require('../config/db')
const upload = require('../middleware/upload')

const {
  adminGetAllCampaigns,
  adminUpdateStatus,
  getCompletionRequests,
  adminReleaseCampaignEscrow,
  adminRefundCampaignEscrow,
} = require('../controllers/campaignController')
const { adminGetAllDonations } = require('../controllers/donationController')
const {
  getStats, getAllUsers, toggleUserActive,
  addUser, deleteUser, verifyUser, unverifyUser,
  changePassword, addAdmin,
  getDisputes, createDispute, resolveDispute,
  getTheme, saveTheme,
  getSettings, saveSettings,
  getContent, saveContent,
  sendMassMail,
  saveFCMToken,
  getVerificationSetting,
  updateVerificationSetting,
  saveAdminFCMToken,
  getAdminFCMTokens,
  removeAdminFCMToken,
  getFirebaseSettings,
  saveFirebaseSettings,
  getImageKitSettings,
  saveImageKitSettings,
  sendTestPushNotification,
} = require('../controllers/adminController')
const {
  getAllDepositRequests,
  updateDepositRequest,
  getAllWithdrawalRequests,
  approveWithdrawal,
  rejectWithdrawal,
  adjustWalletBalance,
  getUserWalletDetails,
} = require('../controllers/adminWalletController')
const {
  getPayoutHistory,
  markAsPaid,
  getPayoutSummary,
  getFeeSettings,
  updateFeeSettings,
  calculateFee,
  getCreatorVerifications,
  reviewCreatorVerification,
  getTopDonors,
  getRecurringDonations,
  updateSubscriptionStatus,
  getDonorAnalytics,
  getAuditLogs,
} = require('../controllers/adminFeaturesController')

// NOTE: authenticate runs once in server.js
router.post('/fcm-token', saveFCMToken)

// ============ EMERGENCY ADMIN LOGIN (WORKS DURING MAINTENANCE) ============
router.post('/emergency-login', async (req, res) => {
  try {
    const { email, password } = req.body
    
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password required' })
    }
    
    // Query the database for admin user
    const result = await pool.query(
      `SELECT id, name, email, password, role, is_active as active 
       FROM users 
       WHERE email = $1 AND role = 'admin'`,
      [email]
    )
    
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' })
    }
    
    const user = result.rows[0]
    
    // Check if user is active
    if (!user.active) {
      return res.status(401).json({ message: 'Account is disabled' })
    }
    
    // Verify password using bcrypt
    const isPasswordValid = await bcrypt.compare(password, user.password)
    
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid credentials' })
    }
    
    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'your-secret-key-change-this',
      { expiresIn: '24h' }
    )
    
    // Return user data (without password)
    const userData = {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      active: user.active
    }
    
    res.json({
      success: true,
      token,
      user: userData,
      message: 'Emergency login successful'
    })
    
  } catch (error) {
    console.error('Emergency login error:', error)
    res.status(500).json({ message: 'Server error during emergency login: ' + error.message })
  }
})

// Apply admin authentication for all subsequent routes
router.use(requireAdmin)

// Stats & Users
router.get('/stats', getStats)
router.get('/users', getAllUsers)
router.patch('/users/:id/toggle', toggleUserActive)

// ============ USER MANAGEMENT (NEW) ============
router.post('/users', addUser)                                    // Add new user
router.delete('/users/:id', deleteUser)                          // Delete user
router.patch('/users/:id/verify', verifyUser)                    // Verify user
router.patch('/users/:id/unverify', unverifyUser)                // Unverify user
router.post('/change-password', changePassword)                  // Change admin password
router.post('/admins', addAdmin)                                 // Add new admin

// Campaigns
router.get('/campaigns', adminGetAllCampaigns)
router.patch('/campaigns/:id/status', adminUpdateStatus)
router.get('/donations', adminGetAllDonations)

// ============ ADMIN CAMPAIGN CREATION ============
// Admin can create campaigns for creators
router.post('/campaigns/create', upload.single('image'), async (req, res, next) => {
  try {
    const { title, description, goal, category, creator_id, status = 'approved' } = req.body;
    
    if (!title || !goal) {
      return res.status(400).json({ error: 'Title and goal are required' });
    }
    
    // If creator_id not provided, use admin's ID or find first creator
    let userId = creator_id;
    if (!userId) {
      const creatorResult = await pool.query(
        "SELECT id FROM users WHERE role = 'creator' LIMIT 1"
      );
      if (creatorResult.rows.length === 0) {
        userId = req.user.id;
      } else {
        userId = creatorResult.rows[0].id;
      }
    }
    
    // Verify creator exists
    const userCheck = await pool.query(
      'SELECT id, name FROM users WHERE id = $1',
      [userId]
    );
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Creator not found' });
    }
    
    let image_url = null;
    let image_file_id = null;
    
    // Upload image if provided
    if (req.file) {
      const { uploadToImageKit } = require('../config/imagekit');
      try {
        const uploadResult = await uploadToImageKit(req.file.buffer, `${Date.now()}-campaign.jpg`, 'hopebridge/campaigns');
        if (uploadResult.url) {
          image_url = uploadResult.url;
          image_file_id = uploadResult.fileId;
        }
      } catch (err) {
        console.warn('Image upload failed:', err.message);
      }
    } else if (req.body.image_url) {
      image_url = req.body.image_url;
    }
    
    const result = await pool.query(
      `INSERT INTO campaigns (creator_id, title, description, goal, image_url, image_file_id, category, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [userId, title.trim(), description?.trim() || null, parseFloat(goal), image_url, image_file_id, category || 'General', status]
    );
    
    // Log to audit
    await pool.query(
      `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.user.id, 'admin_campaign_created', 'campaign', result.rows[0].id, JSON.stringify({ title, creator_id: userId }), req.ip]
    );
    
    res.status(201).json({
      message: `Campaign "${title}" created successfully for ${userCheck.rows[0].name}`,
      campaign: result.rows[0]
    });
  } catch (err) {
    next(err);
  }
});

// ============ MANUAL CAMPAIGN PROGRESS UPDATE ============
router.patch('/campaigns/:id/progress', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { raised } = req.body;
    
    if (raised === undefined || parseFloat(raised) < 0) {
      return res.status(400).json({ error: 'Valid raised amount is required' });
    }
    
    const newRaised = parseFloat(raised);
    
    const result = await pool.query(
      `UPDATE campaigns 
       SET raised = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [newRaised, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    // Log to audit
    await pool.query(
      `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.user.id, 'campaign_progress_updated', 'campaign', id, JSON.stringify({ new_raised: newRaised }), req.ip]
    );
    
    res.json({
      message: `Campaign progress updated to $${newRaised.toFixed(2)}`,
      campaign: result.rows[0]
    });
  } catch (err) {
    next(err);
  }
});

// ============ GET CAMPAIGN BY ID FOR ADMIN ============
router.get('/campaigns/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT c.*, u.name as creator_name, u.email as creator_email
       FROM campaigns c
       JOIN users u ON c.creator_id = u.id
       WHERE c.id = $1`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    res.json({ campaign: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ============ EDIT CAMPAIGN (ADMIN) ============
router.patch('/campaigns/:id/edit', upload.single('image'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, goal, category, status } = req.body;
    
    const existing = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1',
      [id]
    );
    
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (title !== undefined) {
      updates.push(`title = $${paramCount++}`);
      values.push(title.trim());
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description?.trim() || null);
    }
    if (goal !== undefined) {
      updates.push(`goal = $${paramCount++}`);
      values.push(parseFloat(goal));
    }
    if (category !== undefined) {
      updates.push(`category = $${paramCount++}`);
      values.push(category);
    }
    if (status !== undefined) {
      updates.push(`status = $${paramCount++}`);
      values.push(status);
    }
    
    // Handle image upload
    if (req.file) {
      const { uploadToImageKit, deleteFromImageKit } = require('../config/imagekit');
      const oldImageId = existing.rows[0].image_file_id;
      
      try {
        const uploadResult = await uploadToImageKit(req.file.buffer, `${Date.now()}-campaign.jpg`, 'hopebridge/campaigns');
        if (uploadResult.url) {
          updates.push(`image_url = $${paramCount++}`);
          values.push(uploadResult.url);
          updates.push(`image_file_id = $${paramCount++}`);
          values.push(uploadResult.fileId);
          
          // Delete old image
          if (oldImageId) {
            await deleteFromImageKit(oldImageId).catch(console.warn);
          }
        }
      } catch (err) {
        console.warn('Image upload failed:', err.message);
      }
    } else if (req.body.image_url !== undefined) {
      updates.push(`image_url = $${paramCount++}`);
      values.push(req.body.image_url || null);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    values.push(id);
    const query = `
      UPDATE campaigns
      SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = $${paramCount}
      RETURNING *
    `;
    
    const result = await pool.query(query, values);
    
    // Log to audit
    await pool.query(
      `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.user.id, 'admin_campaign_updated', 'campaign', id, JSON.stringify(req.body), req.ip]
    );
    
    res.json({
      message: 'Campaign updated successfully',
      campaign: result.rows[0]
    });
  } catch (err) {
    next(err);
  }
});

// Disputes
router.get('/disputes', getDisputes)
router.post('/disputes', createDispute)
router.patch('/disputes/:id/resolve', resolveDispute)

// Theme
router.get('/theme', getTheme)
router.put('/theme', saveTheme)

// Settings
router.get('/settings', getSettings)
router.put('/settings', saveSettings)

// Content
router.get('/content', getContent)
router.put('/content', saveContent)

// Mass Mail
router.post('/mass-mail', sendMassMail)

// Email Verification
router.get('/verification-setting', getVerificationSetting)
router.put('/verification-setting', updateVerificationSetting)

// Firebase Push Notifications
router.post('/admin-fcm-token', saveAdminFCMToken)
router.get('/admin-fcm-tokens', getAdminFCMTokens)
router.delete('/admin-fcm-token', removeAdminFCMToken)
router.get('/firebase-settings', getFirebaseSettings)
router.put('/firebase-settings', saveFirebaseSettings)
router.post('/test-push', sendTestPushNotification)

// ImageKit.io
router.get('/imagekit-settings', getImageKitSettings)
router.put('/imagekit-settings', saveImageKitSettings)

// Deposit Requests
router.get('/deposit-requests', getAllDepositRequests)
router.put('/deposit-requests/:id', updateDepositRequest)

// Withdrawal Requests
router.get('/withdrawal-requests', getAllWithdrawalRequests)
router.put('/withdrawal-requests/:id/approve', approveWithdrawal)
router.put('/withdrawal-requests/:id/reject', rejectWithdrawal)

// ============ WALLET MANAGEMENT (ADMIN) ============
router.post('/wallet/adjust', adjustWalletBalance)
router.get('/wallet/user/:userId', getUserWalletDetails)

// Escrow & Campaign Completion
router.get('/campaigns/completion-requests', getCompletionRequests)
router.post('/campaigns/:id/release-escrow', adminReleaseCampaignEscrow)
router.post('/campaigns/:id/refund-escrow', adminRefundCampaignEscrow)

// ============ NEW FEATURES ============

// Payout Reconciliation
router.get('/payouts', getPayoutHistory)
router.get('/payouts/summary', getPayoutSummary)
router.put('/payouts/:id/mark-paid', markAsPaid)

// Transaction Fee Management
router.get('/fees', getFeeSettings)
router.put('/fees', updateFeeSettings)
router.post('/fees/calculate', calculateFee)

// Creator Verification
router.get('/creator-verifications', getCreatorVerifications)
router.put('/creator-verifications/:id/review', reviewCreatorVerification)

// Donor Management
router.get('/top-donors', getTopDonors)
router.get('/recurring-donations', getRecurringDonations)
router.put('/recurring-donations/:id/status', updateSubscriptionStatus)
router.get('/donor-analytics', getDonorAnalytics)

// Audit Logs
router.get('/audit-logs', getAuditLogs)

module.exports = router