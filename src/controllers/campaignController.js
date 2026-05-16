const pool = require('../config/db')
const {
  sendCampaignStatusEmail,
  sendNewCampaignAdminAlert,
} = require('../utils/email')

// Helper to ensure image_url is absolute (for local storage fallback)
const ensureAbsoluteImageUrl = (url, req) => {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  return `${req.protocol}://${req.get('host')}${url.startsWith('/') ? url : '/' + url}`;
};

// GET /api/campaigns  — public, approved only (with pagination + search)
const getAllCampaigns = async (req, res, next) => {
  try {
    const { page = 1, limit = 9, search = '', category = '' } = req.query
    const offset = (parseInt(page) - 1) * parseInt(limit)

    const conditions = ["c.status = 'approved'"]
    const values = []
    let idx = 1

    if (search) { conditions.push(`(c.title ILIKE $${idx} OR c.description ILIKE $${idx})`); values.push(`%${search}%`); idx++ }
    if (category) { conditions.push(`c.category = $${idx}`); values.push(category); idx++ }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM campaigns c ${where}`, values
    )

    values.push(parseInt(limit), offset)
    const result = await pool.query(`
      SELECT c.*, u.name AS creator_name,
             (SELECT COALESCE(SUM(amount),0) FROM donations WHERE campaign_id = c.id) AS raised
      FROM campaigns c
      JOIN users u ON c.creator_id = u.id
      ${where}
      ORDER BY c.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `, values)

    // Ensure image URLs are absolute
    const campaigns = result.rows.map(c => ({
      ...c,
      image_url: ensureAbsoluteImageUrl(c.image_url, req)
    }));

    res.json({
      campaigns,
      total:     parseInt(countRes.rows[0].count),
      page:      parseInt(page),
      pages:     Math.ceil(parseInt(countRes.rows[0].count) / parseInt(limit)),
    })
  } catch (err) { next(err) }
}

// GET /api/campaigns/:id — public
const getCampaign = async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT c.*, u.name AS creator_name,
             (SELECT COALESCE(SUM(amount),0) FROM donations WHERE campaign_id = c.id) AS raised
      FROM campaigns c
      JOIN users u ON c.creator_id = u.id
      WHERE c.id = $1
    `, [req.params.id])

    if (result.rows.length === 0) return res.status(404).json({ error: 'Campaign not found.' })
    
    const campaign = {
      ...result.rows[0],
      image_url: ensureAbsoluteImageUrl(result.rows[0].image_url, req)
    };
    res.json({ campaign })
  } catch (err) { next(err) }
}

// POST /api/campaigns  — creator only (UPDATED for Cloudinary)
const createCampaign = async (req, res, next) => {
  try {
    const { title, description, goal, category = 'General' } = req.body
    
    // Get image URL - now from Cloudinary (req.file.path) or body
    // Cloudinary returns the full URL in req.file.path
    let image_url = null;
    if (req.file) {
      // Cloudinary storage provides the URL
      image_url = req.file.path || req.file.secure_url;
      console.log('Image uploaded to Cloudinary:', image_url);
    } else if (req.body.image_url) {
      image_url = req.body.image_url;
    }

    console.log('Creating campaign:', { title, goal, category, image_url });

    const result = await pool.query(`
      INSERT INTO campaigns (creator_id, title, description, goal, image_url, category)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [req.user.id, title.trim(), description?.trim(), parseFloat(goal), image_url, category])

    const campaign = result.rows[0]
    console.log('Campaign created:', campaign.id);

    // Notify admin by email
    const adminRes = await pool.query("SELECT email FROM users WHERE role = 'admin' LIMIT 1")
    if (adminRes.rows.length > 0) {
      sendNewCampaignAdminAlert({
        adminEmail:    adminRes.rows[0].email,
        creatorName:   req.user.name,
        campaignTitle: campaign.title,
        campaignId:    campaign.id,
      }).catch(e => console.warn('Admin alert email failed:', e.message))
    }

    res.status(201).json({ 
      message: 'Campaign submitted for review.', 
      campaign: {
        ...campaign,
        image_url: ensureAbsoluteImageUrl(campaign.image_url, req)
      }
    })
  } catch (err) {
    console.error('Create campaign error:', err);
    next(err)
  }
}

// PATCH /api/campaigns/:id  — creator only, only if pending (UPDATED for Cloudinary)
const updateCampaign = async (req, res, next) => {
  try {
    const existing = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1 AND creator_id = $2',
      [req.params.id, req.user.id]
    )
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Campaign not found.' })
    if (existing.rows[0].status !== 'pending') {
      return res.status(403).json({ error: 'Only pending campaigns can be edited.' })
    }

    const { title, description, goal, category } = req.body
    
    // Get image URL from Cloudinary or keep existing
    let image_url = existing.rows[0].image_url;
    if (req.file) {
      image_url = req.file.path || req.file.secure_url;
      console.log('Updated image uploaded to Cloudinary:', image_url);
    } else if (req.body.image_url) {
      image_url = req.body.image_url;
    }

    const result = await pool.query(`
      UPDATE campaigns
      SET title=$1, description=$2, goal=$3, image_url=$4, category=$5
      WHERE id=$6 AND creator_id=$7
      RETURNING *
    `, [title, description, parseFloat(goal), image_url, category, req.params.id, req.user.id])

    res.json({ 
      message: 'Campaign updated.', 
      campaign: {
        ...result.rows[0],
        image_url: ensureAbsoluteImageUrl(result.rows[0].image_url, req)
      }
    })
  } catch (err) { 
    console.error('Update campaign error:', err);
    next(err) 
  }
}

// DELETE /api/campaigns/:id  — creator or admin
const deleteCampaign = async (req, res, next) => {
  try {
    const query = req.user.role === 'admin'
      ? 'DELETE FROM campaigns WHERE id = $1 RETURNING id'
      : 'DELETE FROM campaigns WHERE id = $1 AND creator_id = $2 RETURNING id'

    const params = req.user.role === 'admin'
      ? [req.params.id]
      : [req.params.id, req.user.id]

    const result = await pool.query(query, params)
    if (result.rows.length === 0) return res.status(404).json({ error: 'Campaign not found.' })

    res.json({ message: 'Campaign deleted.' })
  } catch (err) { next(err) }
}

// GET /api/campaigns/my  — creator's own campaigns
const getMyCampaigns = async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT c.*,
             (SELECT COALESCE(SUM(amount),0) FROM donations WHERE campaign_id = c.id) AS raised
      FROM campaigns c
      WHERE c.creator_id = $1
      ORDER BY c.created_at DESC
    `, [req.user.id])
    
    // Ensure image URLs are absolute
    const campaigns = result.rows.map(c => ({
      ...c,
      image_url: ensureAbsoluteImageUrl(c.image_url, req)
    }));
    
    res.json({ campaigns })
  } catch (err) { next(err) }
}

// ── Admin actions ────────────────────────────────────────────────

// GET /api/admin/campaigns  — all campaigns (any status)
const adminGetAllCampaigns = async (req, res, next) => {
  try {
    const { status } = req.query
    const values = []
    let where = ''
    if (status) { where = 'WHERE c.status = $1'; values.push(status) }

    const result = await pool.query(`
      SELECT c.*, u.name AS creator_name,
             (SELECT COALESCE(SUM(amount),0) FROM donations WHERE campaign_id = c.id) AS raised
      FROM campaigns c JOIN users u ON c.creator_id = u.id
      ${where}
      ORDER BY c.created_at DESC
    `, values)
    
    const campaigns = result.rows.map(c => ({
      ...c,
      image_url: ensureAbsoluteImageUrl(c.image_url, req)
    }));
    
    res.json({ campaigns })
  } catch (err) { next(err) }
}

// PATCH /api/admin/campaigns/:id/status  — approve or reject
const adminUpdateStatus = async (req, res, next) => {
  try {
    const { status } = req.body
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status must be approved or rejected.' })
    }

    const result = await pool.query(`
      UPDATE campaigns SET status = $1 WHERE id = $2
      RETURNING *, (SELECT name FROM users WHERE id = creator_id) AS creator_name,
                   (SELECT email FROM users WHERE id = creator_id) AS creator_email
    `, [status, req.params.id])

    if (result.rows.length === 0) return res.status(404).json({ error: 'Campaign not found.' })

    const camp = result.rows[0]

    // Notify creator
    sendCampaignStatusEmail({
      to:            camp.creator_email,
      creatorName:   camp.creator_name,
      campaignTitle: camp.title,
      status,
    }).catch(e => console.warn('Status email failed:', e.message))

    res.json({ message: `Campaign ${status}.`, campaign: camp })
  } catch (err) { next(err) }
}

// ========== ESCROW & COMPLETION REQUESTS ==========

// Creator requests to complete a campaign (release escrow)
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
      `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS completion_requested BOOLEAN DEFAULT FALSE;
       ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS completion_requested_at TIMESTAMPTZ;`
    );

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

    res.json({ message: 'Completion request sent to admin. Funds will be released after review.' });
  } catch (err) {
    next(err);
  }
};

// Admin releases escrow for a campaign
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

// Admin refunds all escrow for a cancelled campaign
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

// Get all campaigns with pending completion requests (admin)
const getCompletionRequests = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, creator_id, completion_requested_at
       FROM campaigns
       WHERE completion_requested = TRUE AND status = 'approved'
       ORDER BY completion_requested_at ASC`
    );
    res.json({ campaigns: result.rows });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAllCampaigns,
  getCampaign,
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
};