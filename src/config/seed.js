require('dotenv').config()
const bcrypt = require('bcryptjs')
const pool = require('./db')

const seed = async () => {
  const client = await pool.connect()
  try {
    console.log('🌱 Seeding database...')

    // Hash passwords
    const adminHash   = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10)
    const creatorHash = await bcrypt.hash('pass123', 10)
    const donorHash   = await bcrypt.hash('donor123', 10)

    // Clear existing seed data (safe for dev)
    await client.query(`DELETE FROM donations; DELETE FROM campaigns; DELETE FROM disputes; DELETE FROM users;`)

    // Seed users
    const usersRes = await client.query(`
      INSERT INTO users (name, email, password, role) VALUES
        ('Admin User',     $1, $2, 'admin'),
        ('Emily Johnson',  'emily@hope.org',   $3, 'creator'),
        ('Donor Demo',     'donor@hope.org',   $4, 'donor')
      RETURNING id, email, role
    `, [
      process.env.ADMIN_EMAIL || 'admin@hopebridge.com',
      adminHash, creatorHash, donorHash
    ])
    console.log('  ✅ Users seeded:', usersRes.rows.map(u => u.email).join(', '))

    const creatorId = usersRes.rows.find(u => u.role === 'creator').id

    // Seed campaigns
    const campsRes = await client.query(`
      INSERT INTO campaigns (creator_id, title, description, goal, image_url, category, status) VALUES
        ($1, 'School Kits for 500 Kids',
         'Provide notebooks, pens, and uniforms to underprivileged children in rural schools.',
         15000,
         'https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=400&h=200&fit=crop',
         'Education', 'approved'),
        ($1, 'Clean Water Well Project',
         'Build a sustainable borehole and water well for a remote rural community.',
         25000,
         'https://images.unsplash.com/photo-1542810634-71277d95dcbb?w=400&h=200&fit=crop',
         'Water', 'pending')
      RETURNING id, title
    `, [creatorId])
    console.log('  ✅ Campaigns seeded:', campsRes.rows.map(c => c.title).join(', '))

    const approvedId = campsRes.rows[0].id

    // Seed donations
    await client.query(`
      INSERT INTO donations (campaign_id, donor_name, donor_email, amount, message) VALUES
        ($1, 'Michael Asante', 'michael@example.com', 120.00, 'Keep up the great work!'),
        ($1, 'Sarah Mensah',   'sarah@example.com',   250.00, 'Happy to support this cause.')
    `, [approvedId])

    // Update raised amount
    await client.query(`
      UPDATE campaigns SET raised = (
        SELECT COALESCE(SUM(amount), 0) FROM donations WHERE campaign_id = campaigns.id
      )
    `)
    console.log('  ✅ Donations seeded')

    // Seed a dispute
    await client.query(`
      INSERT INTO disputes (type, description, campaign_id, status) VALUES
        ('fraud_alert', 'Suspicious donation pattern detected on School Kits campaign', $1, 'open')
    `, [approvedId])
    console.log('  ✅ Disputes seeded')

    console.log('\n✅ Seed complete! Demo credentials:')
    console.log(`   Admin:   ${process.env.ADMIN_EMAIL || 'admin@hopebridge.com'} / ${process.env.ADMIN_PASSWORD || 'admin123'}`)
    console.log('   Creator: emily@hope.org / pass123')
    console.log('   Donor:   donor@hope.org / donor123')
  } catch (err) {
    console.error('❌ Seed failed:', err.message)
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

seed().catch(() => process.exit(1))
