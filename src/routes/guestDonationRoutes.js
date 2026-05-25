const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const multer = require('multer');
const {
  sendGuestDonationInstructions,
  sendGuestDonationApproved,
  sendGuestDonationRejected
} = require('../utils/email');
const { uploadToImageKit } = require('../config/imagekit');

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WEBP images are allowed'), false);
    }
  }
});

// ─────────────────────────────────────────────
// GUEST: REQUEST DONATION (Step 1)
// UPDATED: Added preferred_payment_method
// ─────────────────────────────────────────────
router.post('/request', async (req, res) => {
  const { campaign_id, guest_name, guest_email, guest_phone, amount, message, preferred_payment_method } = req.body;
  
  try {
    // Validation
    if (!campaign_id || !guest_email || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Campaign, email, and valid amount are required' });
    }
    
    // Check if campaign exists and is approved
    const campaignCheck = await pool.query(
      'SELECT id, title, status FROM campaigns WHERE id = $1',
      [campaign_id]
    );
    
    if (campaignCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    if (campaignCheck.rows[0].status !== 'approved') {
      return res.status(400).json({ error: 'Campaign is not accepting donations' });
    }
    
    const campaign = campaignCheck.rows[0];
    
    // Store preferred payment method (default to bank_transfer if not specified)
    const paymentMethod = preferred_payment_method || 'bank_transfer';
    
    // Create guest donation request
    const result = await pool.query(
      `INSERT INTO guest_donations (campaign_id, guest_name, guest_email, guest_phone, amount, message, payment_method, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_instructions')
       RETURNING id, amount, guest_email, guest_phone, payment_method, payment_status, created_at`,
      [campaign_id, guest_name || null, guest_email, guest_phone || null, amount, message || null, paymentMethod]
    );
    
    const guestDonation = result.rows[0];
    
    console.log(`📧 New guest donation request #${guestDonation.id} from ${guest_email} for $${amount} via ${paymentMethod}`);
    
    // Notify admin (you can also send an email to admin here)
    const adminRes = await pool.query("SELECT email FROM users WHERE role = 'admin' LIMIT 1");
    if (adminRes.rows.length > 0) {
      // Optional: Send admin notification email
      console.log(`🔔 Admin notification: Guest donation #${guestDonation.id} awaiting instructions`);
    }
    
    res.status(201).json({
      success: true,
      message: 'Donation request received. Admin will provide payment instructions shortly.',
      donation: guestDonation
    });
    
  } catch (error) {
    console.error('Guest donation request error:', error);
    res.status(500).json({ error: 'Failed to process donation request' });
  }
});

// ─────────────────────────────────────────────
// ADMIN: GET ALL GUEST DONATION REQUESTS
// UPDATED: Includes guest_phone and preferred payment method
// ─────────────────────────────────────────────
router.get('/admin/guest-donations', async (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT gd.*, c.title as campaign_title
      FROM guest_donations gd
      JOIN campaigns c ON gd.campaign_id = c.id
      ORDER BY gd.created_at DESC
    `;
    let params = [];
    
    if (status && status !== 'all') {
      query = `
        SELECT gd.*, c.title as campaign_title
        FROM guest_donations gd
        JOIN campaigns c ON gd.campaign_id = c.id
        WHERE gd.payment_status = $1
        ORDER BY gd.created_at DESC
      `;
      params = [status];
    }
    
    const result = await pool.query(query, params);
    res.json({ requests: result.rows });
    
  } catch (error) {
    console.error('Get guest donations error:', error);
    res.status(500).json({ error: 'Failed to fetch guest donations' });
  }
});

// ─────────────────────────────────────────────
// ADMIN: SEND PAYMENT INSTRUCTIONS (Step 2)
// UPDATED: Instructions can be tailored based on payment method
// ─────────────────────────────────────────────
router.post('/admin/send-instructions/:id', async (req, res) => {
  const { id } = req.params;
  const { instructions, payment_method } = req.body;
  
  try {
    if (!instructions || instructions.trim() === '') {
      return res.status(400).json({ error: 'Payment instructions are required' });
    }
    
    // Get guest donation with campaign info
    const getResult = await pool.query(
      `SELECT gd.*, c.title as campaign_title 
       FROM guest_donations gd
       JOIN campaigns c ON gd.campaign_id = c.id
       WHERE gd.id = $1`,
      [id]
    );
    
    if (getResult.rows.length === 0) {
      return res.status(404).json({ error: 'Guest donation not found' });
    }
    
    const guestDonation = getResult.rows[0];
    
    if (guestDonation.payment_status !== 'pending_instructions') {
      return res.status(400).json({ error: `Cannot send instructions for status: ${guestDonation.payment_status}` });
    }
    
    // Update with instructions (preserve the original preferred payment method)
    const result = await pool.query(
      `UPDATE guest_donations 
       SET admin_instructions = $1, 
           payment_method = COALESCE($2, payment_method),
           payment_status = 'instructions_sent',
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [instructions, payment_method || guestDonation.payment_method, id]
    );
    
    // Send email to guest
    try {
      await sendGuestDonationInstructions({
        to: guestDonation.guest_email,
        guestName: guestDonation.guest_name || 'Valued Donor',
        amount: guestDonation.amount,
        campaignTitle: guestDonation.campaign_title,
        instructions: instructions,
        donationId: guestDonation.id,
        paymentMethod: payment_method || guestDonation.payment_method
      });
    } catch (emailError) {
      console.warn('Failed to send instructions email:', emailError.message);
    }
    
    res.json({
      success: true,
      message: 'Payment instructions sent to guest',
      donation: result.rows[0]
    });
    
  } catch (error) {
    console.error('Send instructions error:', error);
    res.status(500).json({ error: 'Failed to send instructions' });
  }
});

// ─────────────────────────────────────────────
// GUEST: UPLOAD PAYMENT PROOF (Step 3)
// ─────────────────────────────────────────────
router.post('/upload-proof/:id', upload.single('proof'), async (req, res) => {
  const { id } = req.params;
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Proof image is required' });
    }
    
    // Check if donation exists and is in correct status
    const checkResult = await pool.query(
      'SELECT payment_status, guest_email FROM guest_donations WHERE id = $1',
      [id]
    );
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Donation request not found' });
    }
    
    if (checkResult.rows[0].payment_status !== 'instructions_sent') {
      return res.status(400).json({ 
        error: `Cannot upload proof for status: ${checkResult.rows[0].payment_status}. Please wait for instructions first.`
      });
    }
    
    // Generate unique filename
    const fileName = `guest-proof-${id}-${Date.now()}.jpg`;
    const folder = 'hopebridge/guest-proofs';
    
    // Upload to ImageKit
    const uploadResult = await uploadToImageKit(req.file.buffer, fileName, folder);
    
    if (!uploadResult.success && !uploadResult.url) {
      throw new Error('Image upload failed');
    }
    
    // Update database with ImageKit URL
    const result = await pool.query(
      `UPDATE guest_donations 
       SET proof_image_url = $1, 
           payment_status = 'pending_verification',
           updated_at = NOW()
       WHERE id = $2
       RETURNING id, amount, guest_email, payment_status`,
      [uploadResult.url, id]
    );
    
    console.log(`📸 Proof uploaded for guest donation #${id} - ImageKit URL: ${uploadResult.url}`);
    
    res.json({
      success: true,
      message: 'Payment proof uploaded. Admin will verify and process your donation.',
      donation: result.rows[0],
      imageUrl: uploadResult.url
    });
    
  } catch (error) {
    console.error('Upload proof error:', error);
    res.status(500).json({ error: 'Failed to upload proof: ' + error.message });
  }
});

// ─────────────────────────────────────────────
// ADMIN: APPROVE GUEST DONATION (Step 4)
// ─────────────────────────────────────────────
router.post('/admin/approve/:id', async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;
  
  try {
    await client.query('BEGIN');
    
    // Get guest donation with lock
    const guestResult = await client.query(
      `SELECT gd.*, c.title as campaign_title, c.creator_id
       FROM guest_donations gd
       JOIN campaigns c ON gd.campaign_id = c.id
       WHERE gd.id = $1 FOR UPDATE`,
      [id]
    );
    
    if (guestResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Guest donation not found' });
    }
    
    const gd = guestResult.rows[0];
    
    if (gd.payment_status !== 'pending_verification') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Cannot approve donation with status: ${gd.payment_status}` });
    }
    
    // Create actual donation record
    const donation = await client.query(
      `INSERT INTO donations (campaign_id, donor_name, donor_email, amount, message, payment_method, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', NOW())
       RETURNING *`,
      [gd.campaign_id, gd.guest_name || 'Anonymous', gd.guest_email, gd.amount, gd.message || '', gd.payment_method]
    );
    
    // Update campaign raised amount
    await client.query(
      `UPDATE campaigns SET raised = raised + $1, updated_at = NOW() WHERE id = $2`,
      [gd.amount, gd.campaign_id]
    );
    
    // Update guest donation with reference
    await client.query(
      `UPDATE guest_donations 
       SET payment_status = 'approved', 
           donation_id = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [donation.rows[0].id, id]
    );
    
    await client.query('COMMIT');
    
    // Send confirmation email to guest
    try {
      await sendGuestDonationApproved({
        to: gd.guest_email,
        guestName: gd.guest_name || 'Valued Donor',
        amount: gd.amount,
        campaignTitle: gd.campaign_title
      });
    } catch (emailError) {
      console.warn('Failed to send approval email:', emailError.message);
    }
    
    res.json({
      success: true,
      message: 'Donation approved and credited to campaign',
      donation: donation.rows[0]
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Approve guest donation error:', error);
    res.status(500).json({ error: 'Failed to approve donation' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// ADMIN: REJECT GUEST DONATION
// ─────────────────────────────────────────────
router.post('/admin/reject/:id', async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  
  try {
    // Get guest donation with campaign info
    const getResult = await pool.query(
      `SELECT gd.*, c.title as campaign_title 
       FROM guest_donations gd
       JOIN campaigns c ON gd.campaign_id = c.id
       WHERE gd.id = $1`,
      [id]
    );
    
    if (getResult.rows.length === 0) {
      return res.status(404).json({ error: 'Guest donation not found' });
    }
    
    const gd = getResult.rows[0];
    
    if (gd.payment_status !== 'pending_verification') {
      return res.status(400).json({ error: `Cannot reject donation with status: ${gd.payment_status}` });
    }
    
    const result = await pool.query(
      `UPDATE guest_donations 
       SET payment_status = 'rejected',
           admin_notes = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [reason || 'Payment verification failed', id]
    );
    
    // Send rejection email
    try {
      await sendGuestDonationRejected({
        to: gd.guest_email,
        guestName: gd.guest_name || 'Valued Donor',
        amount: gd.amount,
        campaignTitle: gd.campaign_title,
        reason: reason || 'Payment could not be verified',
        donationId: gd.id
      });
    } catch (emailError) {
      console.warn('Failed to send rejection email:', emailError.message);
    }
    
    res.json({
      success: true,
      message: 'Donation request rejected',
      donation: result.rows[0]
    });
    
  } catch (error) {
    console.error('Reject guest donation error:', error);
    res.status(500).json({ error: 'Failed to reject donation' });
  }
});

// ─────────────────────────────────────────────
// GUEST: CHECK DONATION STATUS
// ─────────────────────────────────────────────
router.get('/status/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await pool.query(
      `SELECT id, amount, payment_status, admin_instructions, proof_image_url, payment_method, created_at, updated_at
       FROM guest_donations 
       WHERE id = $1`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Donation not found' });
    }
    
    res.json({ donation: result.rows[0] });
    
  } catch (error) {
    console.error('Check status error:', error);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// ─────────────────────────────────────────────
// ADMIN: GET STATISTICS
// ─────────────────────────────────────────────
router.get('/admin/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN payment_status = 'pending_instructions' THEN 1 ELSE 0 END) as pending_instructions,
        SUM(CASE WHEN payment_status = 'instructions_sent' THEN 1 ELSE 0 END) as instructions_sent,
        SUM(CASE WHEN payment_status = 'pending_verification' THEN 1 ELSE 0 END) as pending_verification,
        SUM(CASE WHEN payment_status = 'approved' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN payment_status = 'rejected' THEN 1 ELSE 0 END) as rejected,
        COALESCE(SUM(CASE WHEN payment_status = 'approved' THEN amount ELSE 0 END), 0) as total_approved_amount
      FROM guest_donations
    `);
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get guest donation stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ─────────────────────────────────────────────
// ADMIN: GET PAYMENT METHOD STATISTICS
// ─────────────────────────────────────────────
router.get('/admin/payment-methods', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        payment_method,
        COUNT(*) as total,
        SUM(CASE WHEN payment_status = 'approved' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN payment_status = 'pending_verification' THEN 1 ELSE 0 END) as pending,
        COALESCE(SUM(CASE WHEN payment_status = 'approved' THEN amount ELSE 0 END), 0) as total_amount
      FROM guest_donations
      GROUP BY payment_method
      ORDER BY total DESC
    `);
    
    res.json({ paymentMethods: result.rows });
  } catch (error) {
    console.error('Get payment method stats error:', error);
    res.status(500).json({ error: 'Failed to fetch payment method stats' });
  }
});

module.exports = router;