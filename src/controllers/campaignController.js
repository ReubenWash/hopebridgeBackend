const pool = require('../config/db')
const {
  sendCampaignStatusEmail,
  sendNewCampaignAdminAlert,
} = require('../utils/email')

// Helper to ensure image_url is absolute
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

// POST /api/campaigns  — creator only
const createCampaign = async (req, res, next) => {
  try {
    const { title, description, goal, category = 'General' } = req.body
    const image_url = req.file
      ? `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`
      : req.body.image_url || null

    const result = await pool.query(`
      INSERT INTO campaigns (creator_id, title, description, goal, image_url, category)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [req.user.id, title.trim(), description?.trim(), parseFloat(goal), image_url, category])

    const campaign = result.rows[0]

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

    res.status(201).json({ message: 'Campaign submitted for review.', campaign })
  } catch (err) { next(err) }
}

// PATCH /api/campaigns/:id  — creator only, only if pending
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
    const image_url = req.file
      ? `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`
      : req.body.image_url || existing.rows[0].image_url

    const result = await pool.query(`
      UPDATE campaigns
      SET title=$1, description=$2, goal=$3, image_url=$4, category=$5
      WHERE id=$6 AND creator_id=$7
      RETURNING *
    `, [title, description, parseFloat(goal), image_url, category, req.params.id, req.user.id])

    res.json({ message: 'Campaign updated.', campaign: result.rows[0] })
  } catch (err) { next(err) }
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

module.exports = {
  getAllCampaigns, getCampaign, createCampaign,
  updateCampaign, deleteCampaign, getMyCampaigns,
  adminGetAllCampaigns, adminUpdateStatus,
}