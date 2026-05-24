const pool = require('../config/db');
const { uploadToImageKit, deleteFromImageKit } = require('../config/imagekit');
const {
  sendCampaignStatusEmail,
  sendNewCampaignAdminAlert,
} = require('../utils/email');

// Helper to get setting from database
const getSetting = async (key) => {
  const res = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return res.rows.length ? res.rows[0].value : null;
};

// Helper to ensure image_url is absolute (for local storage fallback)
const ensureAbsoluteImageUrl = (url, req) => {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  return `${req.protocol}://${req.get('host')}${url.startsWith('/') ? url : '/' + url}`;
};

// Helper to upload image to ImageKit.io
// Helper to upload image to ImageKit.io
const uploadCampaignImage = async (file, existingImageId = null) => {
  try {
    console.log('📤 Starting ImageKit upload process...');
    
    // Delete old image if exists
    if (existingImageId) {
      try {
        await deleteFromImageKit(existingImageId);
        console.log('🗑️ Old image deleted from ImageKit.io:', existingImageId);
      } catch (deleteErr) {
        console.warn('Failed to delete old image:', deleteErr.message);
      }
    }
    
    // Get file buffer - handle different multer setups
    let fileBuffer;
    let originalName;
    
    if (file.buffer) {
      fileBuffer = file.buffer;
      originalName = file.originalname;
    } else if (file.path) {
      const fs = require('fs');
      fileBuffer = fs.readFileSync(file.path);
      originalName = file.originalname;
    } else {
      throw new Error('No file buffer or path available');
    }
    
    // Get file extension
    const extension = originalName?.split('.').pop() || 'png';
    const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}.${extension}`;
    
    console.log('📤 Uploading to ImageKit.io:', { fileName, size: fileBuffer.length });
    
    const uploadResult = await uploadToImageKit(fileBuffer, fileName, 'hopebridge/campaigns');
    
    if (uploadResult && uploadResult.url) {
      console.log('✅ Image uploaded to ImageKit.io:', uploadResult.url);
      return {
        url: uploadResult.url,
        fileId: uploadResult.fileId,
        usingFallback: false,
      };
    } else {
      throw new Error('Upload failed - no URL returned');
    }
  } catch (err) {
    console.error('❌ Image upload error:', err.message);
    console.log('⚠️ Using fallback (no image will be saved)');
    return { url: null, fileId: null, usingFallback: true };
  }
};

// GET /api/campaigns — public, approved only (with pagination + search)
const getAllCampaigns = async (req, res, next) => {
  try {
    const { page = 1, limit = 9, search = '', category = '' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = ["c.status = 'approved'"];
    const values = [];
    let idx = 1;

    if (search) { 
      conditions.push(`(c.title ILIKE $${idx} OR c.description ILIKE $${idx})`); 
      values.push(`%${search}%`); 
      idx++; 
    }
    if (category) { 
      conditions.push(`c.category = $${idx}`); 
      values.push(category); 
      idx++; 
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM campaigns c ${where}`, values
    );

    values.push(parseInt(limit), offset);
    const result = await pool.query(`
      SELECT c.*, u.name AS creator_name, u.id AS creator_id,
             (SELECT COALESCE(SUM(amount),0) FROM donations WHERE campaign_id = c.id) AS raised
      FROM campaigns c
      JOIN users u ON c.creator_id = u.id
      ${where}
      ORDER BY c.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `, values);

    const campaigns = result.rows.map(c => ({
      ...c,
      raised: parseFloat(c.raised) || 0,
      goal: parseFloat(c.goal),
      image_url: ensureAbsoluteImageUrl(c.image_url, req) || 'https://placehold.co/600x400?text=No+Image',
    }));

    res.json({
      campaigns,
      total: parseInt(countRes.rows[0].count),
      page: parseInt(page),
      pages: Math.ceil(parseInt(countRes.rows[0].count) / parseInt(limit)),
    });
  } catch (err) { 
    next(err); 
  }
};

// GET /api/campaigns/:id — public
const getCampaign = async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT c.*, u.name AS creator_name, u.id AS creator_id,
             (SELECT COALESCE(SUM(amount),0) FROM donations WHERE campaign_id = c.id) AS raised
      FROM campaigns c
      JOIN users u ON c.creator_id = u.id
      WHERE c.id = $1
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found.' });
    }
    
    const campaign = {
      ...result.rows[0],
      raised: parseFloat(result.rows[0].raised) || 0,
      goal: parseFloat(result.rows[0].goal),
      image_url: ensureAbsoluteImageUrl(result.rows[0].image_url, req) || 'https://placehold.co/600x400?text=No+Image',
    };
    
    res.json({ campaign });
  } catch (err) { 
    next(err); 
  }
};

// GET /api/campaigns/:id/updates — get campaign updates
const getCampaignUpdates = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT * FROM campaign_updates 
      WHERE campaign_id = $1 
      ORDER BY created_at DESC
    `, [id]);
    
    res.json({ updates: result.rows });
  } catch (err) { 
    next(err); 
  }
};

// POST /api/campaigns/:id/updates — add campaign update (creator only)
const addCampaignUpdate = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, content } = req.body;
    
    const campaignCheck = await pool.query(
      'SELECT id, creator_id, status FROM campaigns WHERE id = $1',
      [id]
    );
    
    if (campaignCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    if (campaignCheck.rows[0].creator_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to update this campaign' });
    }
    
    const result = await pool.query(`
      INSERT INTO campaign_updates (campaign_id, title, content)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [id, title.trim(), content.trim()]);
    
    res.status(201).json({ 
      message: 'Update added successfully', 
      update: result.rows[0] 
    });
  } catch (err) { 
    next(err); 
  }
};

// POST /api/campaigns — creator only (UPDATED for ImageKit.io)
const createCampaign = async (req, res, next) => {
  try {
    console.log('===== BACKEND CREATE CAMPAIGN DEBUG =====')
    console.log('Content-Type:', req.headers['content-type'])
    console.log('req.file:', req.file)
    console.log('req.body:', req.body)
    console.log('req.files:', req.files)
    
    if (req.file) {
      console.log('File details:', {
        fieldname: req.file.fieldname,
        originalname: req.file.originalname,
        encoding: req.file.encoding,
        mimetype: req.file.mimetype,
        size: req.file.size,
        hasBuffer: !!req.file.buffer,
        bufferLength: req.file.buffer ? req.file.buffer.length : 0
      })
    }
    console.log('========================================')
    
    const { title, description, goal, category = 'General' } = req.body;
    
    // Validation
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Campaign title is required' });
    }
    if (!goal || parseFloat(goal) < 10) {
      return res.status(400).json({ error: 'Campaign goal must be at least $10' });
    }
    
    let image_url = null;
    let image_file_id = null;

    // Upload to ImageKit if file exists
    if (req.file) {
      console.log('📤 Attempting to upload file to ImageKit.io...')
      const uploadResult = await uploadCampaignImage(req.file);
      if (uploadResult.url) {
        image_url = uploadResult.url;
        image_file_id = uploadResult.fileId;
        console.log('✅ Image uploaded successfully:', image_url)
      } else {
        console.log('⚠️ Image upload failed, using fallback')
      }
    } else if (req.body.image_url && req.body.image_url.trim()) {
      image_url = req.body.image_url.trim();
      console.log('Using provided image URL:', image_url);
    } else {
      console.log('No image provided for campaign')
    }

    console.log('📝 Creating campaign:', { 
      title: title.trim(), 
      goal: parseFloat(goal), 
      category, 
      hasImage: !!image_url 
    });

    const result = await pool.query(`
      INSERT INTO campaigns (creator_id, title, description, goal, image_url, category, image_file_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [req.user.id, title.trim(), description?.trim() || null, parseFloat(goal), image_url, category, image_file_id]);

    const campaign = result.rows[0];
    console.log('✅ Campaign created successfully, ID:', campaign.id);

    // Notify admin by email
    const adminRes = await pool.query("SELECT email FROM users WHERE role = 'admin' LIMIT 1");
    if (adminRes.rows.length > 0) {
      sendNewCampaignAdminAlert({
        adminEmail: adminRes.rows[0].email,
        creatorName: req.user.name,
        campaignTitle: campaign.title,
        campaignId: campaign.id,
      }).catch(e => console.warn('⚠️ Admin alert email failed:', e.message));
    }

    res.status(201).json({ 
      message: 'Campaign submitted for review successfully!', 
      campaign: {
        id: campaign.id,
        title: campaign.title,
        description: campaign.description,
        goal: parseFloat(campaign.goal),
        raised: 0,
        image_url: image_url || null,
        category: campaign.category,
        status: campaign.status,
        created_at: campaign.created_at,
      },
    });
  } catch (err) {
    console.error('❌ Create campaign error:', err);
    next(err);
  }
};

// PATCH /api/campaigns/:id — creator only, only if pending (UPDATED for ImageKit.io)
const updateCampaign = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const existing = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1 AND creator_id = $2',
      [id, req.user.id]
    );
    
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found or you do not have permission to edit it.' });
    }
    
    const existingCampaign = existing.rows[0];
    
    if (existingCampaign.status !== 'pending') {
      return res.status(403).json({ 
        error: `Only pending campaigns can be edited. Current status: ${existingCampaign.status}` 
      });
    }

    const { title, description, goal, category } = req.body;
    
    let image_url = existingCampaign.image_url;
    let image_file_id = existingCampaign.image_file_id;

    // Upload new image to ImageKit if provided
    if (req.file) {
      const uploadResult = await uploadCampaignImage(req.file, image_file_id);
      if (uploadResult.url) {
        image_url = uploadResult.url;
        image_file_id = uploadResult.fileId;
      }
    } else if (req.body.image_url !== undefined) {
      image_url = req.body.image_url?.trim() || null;
      if (!image_url && image_file_id) {
        try {
          await deleteFromImageKit(image_file_id);
          image_file_id = null;
          console.log('🗑️ Image deleted from ImageKit.io for campaign:', id);
        } catch (deleteErr) {
          console.warn('Failed to delete image from ImageKit:', deleteErr.message);
        }
      }
    }

    // Build update query dynamically
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
    if (image_url !== undefined) {
      updates.push(`image_url = $${paramCount++}`);
      values.push(image_url);
    }
    if (image_file_id !== undefined) {
      updates.push(`image_file_id = $${paramCount++}`);
      values.push(image_file_id);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    values.push(id);
    values.push(req.user.id);
    
    const query = `
      UPDATE campaigns
      SET ${updates.join(', ')}
      WHERE id = $${paramCount} AND creator_id = $${paramCount + 1}
      RETURNING *
    `;
    
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found or update failed.' });
    }

    const updatedCampaign = result.rows[0];
    
    console.log('✅ Campaign updated successfully, ID:', id);

    res.json({ 
      message: 'Campaign updated successfully!', 
      campaign: {
        id: updatedCampaign.id,
        title: updatedCampaign.title,
        description: updatedCampaign.description,
        goal: parseFloat(updatedCampaign.goal),
        raised: parseFloat(updatedCampaign.raised) || 0,
        image_url: updatedCampaign.image_url,
        category: updatedCampaign.category,
        status: updatedCampaign.status,
        created_at: updatedCampaign.created_at,
        updated_at: updatedCampaign.updated_at,
      },
    });
  } catch (err) { 
    console.error('❌ Update campaign error:', err);
    next(err); 
  }
};

// DELETE /api/campaigns/:id — creator or admin (with ImageKit cleanup)
const deleteCampaign = async (req, res, next) => {
  try {
    const campaign = await pool.query(
      'SELECT image_file_id FROM campaigns WHERE id = $1',
      [req.params.id]
    );

    const query = req.user.role === 'admin'
      ? 'DELETE FROM campaigns WHERE id = $1 RETURNING id'
      : 'DELETE FROM campaigns WHERE id = $1 AND creator_id = $2 RETURNING id';

    const params = req.user.role === 'admin'
      ? [req.params.id]
      : [req.params.id, req.user.id];

    const result = await pool.query(query, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found.' });
    }

    if (campaign.rows[0]?.image_file_id) {
      await deleteFromImageKit(campaign.rows[0].image_file_id).catch(console.warn);
    }

    res.json({ message: 'Campaign deleted.' });
  } catch (err) { 
    next(err); 
  }
};

// GET /api/campaigns/my — creator's own campaigns
const getMyCampaigns = async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT c.*, u.id AS creator_id,
             (SELECT COALESCE(SUM(amount),0) FROM donations WHERE campaign_id = c.id) AS raised
      FROM campaigns c
      JOIN users u ON c.creator_id = u.id
      WHERE c.creator_id = $1
      ORDER BY c.created_at DESC
    `, [req.user.id]);
    
    const campaigns = result.rows.map(c => ({
      ...c,
      raised: parseFloat(c.raised) || 0,
      goal: parseFloat(c.goal),
      image_url: ensureAbsoluteImageUrl(c.image_url, req) || 'https://placehold.co/600x400?text=No+Image',
    }));
    
    res.json({ campaigns });
  } catch (err) { 
    next(err); 
  }
};

// ── Admin actions ────────────────────────────────────────────────

// GET /api/admin/campaigns — all campaigns (any status)
const adminGetAllCampaigns = async (req, res, next) => {
  try {
    const { status } = req.query;
    const values = [];
    let where = '';
    if (status) { 
      where = 'WHERE c.status = $1'; 
      values.push(status); 
    }

    const result = await pool.query(`
      SELECT c.*, u.name AS creator_name, u.id AS creator_id,
             (SELECT COALESCE(SUM(amount),0) FROM donations WHERE campaign_id = c.id) AS raised
      FROM campaigns c JOIN users u ON c.creator_id = u.id
      ${where}
      ORDER BY c.created_at DESC
    `, values);
    
    const campaigns = result.rows.map(c => ({
      ...c,
      raised: parseFloat(c.raised) || 0,
      goal: parseFloat(c.goal),
      image_url: ensureAbsoluteImageUrl(c.image_url, req) || 'https://placehold.co/600x400?text=No+Image',
    }));
    
    res.json({ campaigns });
  } catch (err) { 
    next(err); 
  }
};

// PATCH /api/admin/campaigns/:id/status — approve or reject
const adminUpdateStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status must be approved or rejected.' });
    }

    const result = await pool.query(`
      UPDATE campaigns SET status = $1 WHERE id = $2
      RETURNING *, (SELECT name FROM users WHERE id = creator_id) AS creator_name,
                   (SELECT email FROM users WHERE id = creator_id) AS creator_email
    `, [status, req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found.' });
    }

    const camp = result.rows[0];

    sendCampaignStatusEmail({
      to: camp.creator_email,
      creatorName: camp.creator_name,
      campaignTitle: camp.title,
      status,
    }).catch(e => console.warn('Status email failed:', e.message));

    res.json({ message: `Campaign ${status}.`, campaign: camp });
  } catch (err) { 
    next(err); 
  }
};

// ========== ESCROW & COMPLETION REQUESTS ==========

const requestCampaignCompletion = async (req, res, next) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    const campRes = await pool.query(
      'SELECT id, creator_id, status FROM campaigns WHERE id = $1 AND creator_id = $2',
      [id, userId]
    );
    
    if (campRes.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found or not yours' });
    }
    
    if (campRes.rows[0].status !== 'approved') {
      return res.status(400).json({ error: 'Only approved campaigns can be completed' });
    }

    await pool.query(
      `UPDATE campaigns
       SET completion_requested = TRUE, completion_requested_at = NOW()
       WHERE id = $1`,
      [id]
    );

    const adminRes = await pool.query("SELECT email FROM users WHERE role = 'admin' LIMIT 1");
    if (adminRes.rows.length > 0) {
      console.log(`Admin notified: Campaign ${id} completion requested by user ${userId}`);
    }

    res.json({ 
      message: 'Completion request sent to admin. Funds will be released after review.' 
    });
  } catch (err) {
    next(err);
  }
};

const adminReleaseCampaignEscrow = async (req, res, next) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const escrows = await client.query(
      `SELECT eh.*, d.donor_id
       FROM escrow_holds eh
       JOIN donations d ON eh.donation_id = d.id
       WHERE eh.campaign_id = $1 AND eh.status = 'held'`,
      [id]
    );

    if (escrows.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No held escrow found for this campaign' });
    }

    const campRes = await client.query(
      'SELECT id, title, creator_id FROM campaigns WHERE id = $1',
      [id]
    );
    
    if (campRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    const campaign = campRes.rows[0];
    const creatorId = campaign.creator_id;

    let totalReleased = 0;

    for (const escrow of escrows.rows) {
      await client.query(
        `INSERT INTO wallets (user_id, balance) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + $2`,
        [creatorId, escrow.amount]
      );

      await client.query(
        `INSERT INTO wallet_transactions (user_id, amount, type, reference_id, description)
         VALUES ($1, $2, 'escrow_release', $3, $4)`,
        [creatorId, escrow.amount, escrow.id, `Escrow release for campaign "${campaign.title}"`]
      );

      await client.query(
        `UPDATE escrow_holds SET status = 'released', released_at = NOW() WHERE id = $1`,
        [escrow.id]
      );

      await client.query(
        `UPDATE donations SET escrow_status = 'released' WHERE id = $1`,
        [escrow.donation_id]
      );

      totalReleased += parseFloat(escrow.amount);
    }

    await client.query(
      `UPDATE campaigns SET raised = raised + $1, status = 'completed' WHERE id = $2`,
      [totalReleased, id]
    );

    await client.query(
      `UPDATE campaigns SET completion_requested = FALSE WHERE id = $1`,
      [id]
    );

    await client.query('COMMIT');

    res.json({
      message: `Released $${totalReleased.toFixed(2)} to creator for campaign "${campaign.title}"`,
      totalReleased,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

const adminRefundCampaignEscrow = async (req, res, next) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const escrows = await client.query(
      `SELECT eh.*, d.donor_id
       FROM escrow_holds eh
       JOIN donations d ON eh.donation_id = d.id
       WHERE eh.campaign_id = $1 AND eh.status = 'held'`,
      [id]
    );

    if (escrows.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No held escrow found for this campaign' });
    }

    const campRes = await client.query(
      'SELECT title FROM campaigns WHERE id = $1',
      [id]
    );
    const campaignTitle = campRes.rows[0]?.title || 'Campaign';

    for (const escrow of escrows.rows) {
      await client.query(
        `INSERT INTO wallets (user_id, balance) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + $2`,
        [escrow.donor_id, escrow.amount]
      );

      await client.query(
        `INSERT INTO wallet_transactions (user_id, amount, type, reference_id, description)
         VALUES ($1, $2, 'escrow_refund', $3, $4)`,
        [escrow.donor_id, escrow.amount, escrow.id, `Refund for cancelled campaign "${campaignTitle}"`]
      );

      await client.query(
        `UPDATE escrow_holds SET status = 'refunded', released_at = NOW() WHERE id = $1`,
        [escrow.id]
      );

      await client.query(
        `UPDATE donations SET escrow_status = 'refunded' WHERE id = $1`,
        [escrow.donation_id]
      );
    }

    await client.query(
      `UPDATE campaigns SET status = 'rejected' WHERE id = $1`,
      [id]
    );

    await client.query('COMMIT');

    res.json({
      message: `Refunded all escrow for campaign "${campaignTitle}"`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

const getCompletionRequests = async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT 
        id,
        title,
        creator_id,
        completion_requested,
        completion_requested_at,
        status
      FROM campaigns
      WHERE completion_requested = true 
        AND status = 'approved'
      ORDER BY completion_requested_at DESC
    `);
    
    // Get creator names separately if needed
    const campaignsWithNames = [];
    for (const campaign of result.rows) {
      const userRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [campaign.creator_id]);
      campaignsWithNames.push({
        ...campaign,
        creator_name: userRes.rows[0]?.name || 'Unknown',
        creator_email: userRes.rows[0]?.email || 'Unknown'
      });
    }
    
    res.json({ campaigns: campaignsWithNames });
  } catch (err) {
    console.error('Error in getCompletionRequests:', err);
    res.status(500).json({ error: err.message });
  }
};
const getRelatedCampaigns = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { category } = req.query;
    
    if (!category) {
      return res.json({ campaigns: [] });
    }
    
    const result = await pool.query(`
      SELECT c.*, u.name AS creator_name,
             (SELECT COALESCE(SUM(amount),0) FROM donations WHERE campaign_id = c.id) AS raised
      FROM campaigns c
      JOIN users u ON c.creator_id = u.id
      WHERE c.category = $1 AND c.id != $2 AND c.status = 'approved'
      ORDER BY c.created_at DESC
      LIMIT 3
    `, [category, id]);
    
    const campaigns = result.rows.map(c => ({
      ...c,
      raised: parseFloat(c.raised) || 0,
      goal: parseFloat(c.goal),
      image_url: ensureAbsoluteImageUrl(c.image_url, req) || 'https://placehold.co/600x400?text=No+Image',
    }));
    
    res.json({ campaigns });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAllCampaigns,
  getCampaign,
  getCampaignUpdates,
  addCampaignUpdate,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  getMyCampaigns,
  adminGetAllCampaigns,
  adminUpdateStatus,
  requestCampaignCompletion,
  adminReleaseCampaignEscrow,
  adminRefundCampaignEscrow,
  getCompletionRequests,
  getRelatedCampaigns,
};