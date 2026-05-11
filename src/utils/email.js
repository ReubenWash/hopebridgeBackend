const nodemailer = require('nodemailer')
const pool = require('../config/db')   // assuming pool is exported

// Helper: get SMTP settings from database
async function getSmtpSettings() {
  const res = await pool.query(
    "SELECT key, value FROM settings WHERE key IN ('smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass')"
  )
  const settings = {}
  res.rows.forEach(row => { settings[row.key] = row.value })
  // Fallback to environment variables if not set in DB
  return {
    host: settings.smtp_host || process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(settings.smtp_port || process.env.SMTP_PORT || 587),
    user: settings.smtp_user || process.env.SMTP_USER,
    pass: settings.smtp_pass || process.env.SMTP_PASS,
  }
}

// Helper: create a transporter from DB settings
async function createTransporter() {
  const { host, port, user, pass } = await getSmtpSettings()
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  })
}

// Base HTML email wrapper
const htmlWrap = (body) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Open Sans', Arial, sans-serif; background: #f8f9fa; margin: 0; padding: 0; }
    .container { max-width: 580px; margin: 32px auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,.08); }
    .header { background: linear-gradient(135deg,#e8531e,#f47c50); padding: 32px 36px; color: #fff; }
    .header h1 { margin: 0; font-size: 1.5rem; }
    .header p  { margin: 6px 0 0; opacity: .85; font-size: .9rem; }
    .body { padding: 32px 36px; color: #444; line-height: 1.7; }
    .body h2 { color: #1a1a2e; margin-top: 0; }
    .highlight { background: rgba(232,83,30,.08); border-left: 4px solid #e8531e; padding: 14px 18px; border-radius: 0 8px 8px 0; margin: 20px 0; }
    .btn { display: inline-block; background: linear-gradient(135deg,#e8531e,#f47c50); color: #fff !important; text-decoration: none; padding: 13px 28px; border-radius: 6px; font-weight: 700; margin-top: 12px; }
    .footer { background: #1a1a2e; padding: 20px 36px; color: rgba(255,255,255,.5); font-size: .82rem; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>❤ HopeBridge</h1>
      <p>Empowering communities through transparent giving</p>
    </div>
    <div class="body">${body}</div>
    <div class="footer">© ${new Date().getFullYear()} HopeBridge · All Rights Reserved</div>
  </div>
</body>
</html>`

// ── Core email templates ───────────────────────────────────────────

async function sendWelcomeEmail({ to, name, role }) {
  const transporter = await createTransporter()
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || '"HopeBridge" <noreply@hopebridge.org>',
    to,
    subject: `Welcome to HopeBridge, ${name}! 🎉`,
    html: htmlWrap(`
      <h2>Welcome, ${name}!</h2>
      <p>Thank you for joining HopeBridge as a <strong>${role}</strong>.</p>
      <div class="highlight">
        <strong>Next step:</strong> Create your first campaign and start making an impact!
      </div>
      <p>Every contribution — no matter how small — makes a real difference.</p>
    `),
  })
}

async function sendDonationConfirmation({ to, donorName, amount, campaignTitle }) {
  const transporter = await createTransporter()
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || '"HopeBridge" <noreply@hopebridge.org>',
    to,
    subject: `Thank you for your donation of $${amount}! 💛`,
    html: htmlWrap(`
      <h2>Your donation was received!</h2>
      <p>Dear <strong>${donorName}</strong>,</p>
      <p>Thank you for your generous donation to:</p>
      <div class="highlight">
        <strong>${campaignTitle}</strong><br>
        Amount: <strong>$${parseFloat(amount).toFixed(2)}</strong>
      </div>
      <p>Your support directly helps people in need. We'll keep you updated on the impact your donation creates.</p>
      <p>With gratitude,<br>The HopeBridge Team ❤</p>
    `),
  })
}

async function sendCampaignStatusEmail({ to, creatorName, campaignTitle, status }) {
  const transporter = await createTransporter()
  const approved = status === 'approved'
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || '"HopeBridge" <noreply@hopebridge.org>',
    to,
    subject: `Your campaign "${campaignTitle}" has been ${status}`,
    html: htmlWrap(`
      <h2>Campaign ${approved ? 'Approved! 🎉' : 'Not Approved'}</h2>
      <p>Dear <strong>${creatorName}</strong>,</p>
      <div class="highlight">
        Your campaign <strong>"${campaignTitle}"</strong> has been
        <strong style="color:${approved ? '#27a96c' : '#e8531e'}">${status.toUpperCase()}</strong>.
      </div>
      ${approved
        ? '<p>Your campaign is now live and visible to donors. Share it with your network to start raising funds!</p>'
        : '<p>Unfortunately your campaign did not meet our guidelines. Please review our campaign policy and feel free to submit a new one.</p>'
      }
    `),
  })
}

async function sendNewCampaignAdminAlert({ adminEmail, creatorName, campaignTitle, campaignId }) {
  const transporter = await createTransporter()
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || '"HopeBridge" <noreply@hopebridge.org>',
    to: adminEmail,
    subject: `[Admin] New campaign pending review: "${campaignTitle}"`,
    html: htmlWrap(`
      <h2>New Campaign Needs Review</h2>
      <p>A new campaign has been submitted and is awaiting your approval:</p>
      <div class="highlight">
        <strong>Title:</strong> ${campaignTitle}<br>
        <strong>Creator:</strong> ${creatorName}<br>
        <strong>Campaign ID:</strong> #${campaignId}
      </div>
      <p>Please log in to the admin dashboard to approve or reject this campaign.</p>
    `),
  })
}

async function sendVerificationEmail({ to, name, code }) {
  const transporter = await createTransporter()
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || '"HopeBridge" <noreply@hopebridge.org>',
    to,
    subject: 'Your HopeBridge Verification Code',
    html: htmlWrap(`
      <h2>Hi ${name}!</h2>
      <p>Thank you for registering. Please enter the following code to verify your email address:</p>
      <div style="text-align:center; margin:24px 0;">
        <span style="font-size:2rem; font-weight:700; letter-spacing:6px; color:#e8531e;">${code}</span>
      </div>
      <p>This code will expire in 15 minutes.</p>
    `),
  })
}

async function sendNewDonationAdminAlert({ adminEmail, donorName, amount, campaignTitle, campaignId, paymentMethod }) {
  const transporter = await createTransporter()
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || '"HopeBridge" <noreply@hopebridge.org>',
    to: adminEmail,
    subject: `[New Donation] $${amount} received for "${campaignTitle}"`,
    html: htmlWrap(`
      <h2>New Donation Received! 💰</h2>
      <p>A new donation has been successfully processed on the platform.</p>
      <div class="highlight">
        <strong>Campaign:</strong> ${campaignTitle}<br>
        <strong>Donor:</strong> ${donorName || 'Anonymous'}<br>
        <strong>Amount:</strong> <strong>$${amount}</strong><br>
        <strong>Payment Method:</strong> ${paymentMethod}<br>
        <strong>Campaign ID:</strong> #${campaignId}
      </div>
      <p>Visit the <a href="${process.env.ADMIN_URL || 'https://hopebridge.org/admin'}" style="color:#e8531e;">admin dashboard</a> to see all recent donations.</p>
    `),
  })
}

// ── Wallet-related email alerts ───────────────────────────────────

// Admin: new deposit request
async function sendNewDepositRequestAlert({ adminEmail, userName, userEmail, amount, requestId }) {
  const transporter = await createTransporter()
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || '"HopeBridge" <noreply@hopebridge.org>',
    to: adminEmail,
    subject: `[Deposit Request] $${amount} from ${userName}`,
    html: htmlWrap(`
      <h2>New Deposit Request 💰</h2>
      <p>A user has requested a wallet deposit:</p>
      <div class="highlight">
        <strong>User:</strong> ${userName} (${userEmail})<br>
        <strong>Amount:</strong> $${amount}<br>
        <strong>Request ID:</strong> #${requestId}
      </div>
      <p>Please log in to the admin dashboard to provide payment instructions.</p>
    `),
  })
}

// User: deposit request status update (approved/rejected)
async function sendDepositStatusEmail({ to, userName, amount, status, adminNote, requestId }) {
  const transporter = await createTransporter()
  const isApproved = status === 'approved'
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || '"HopeBridge" <noreply@hopebridge.org>',
    to,
    subject: `Your deposit request of $${amount} has been ${status}`,
    html: htmlWrap(`
      <h2>Deposit Request ${isApproved ? 'Approved ✅' : 'Rejected ❌'}</h2>
      <p>Dear <strong>${userName}</strong>,</p>
      <div class="highlight">
        <strong>Amount:</strong> $${amount}<br>
        <strong>Status:</strong> ${status.toUpperCase()}
      </div>
      ${adminNote ? `<p><strong>Admin note:</strong> ${adminNote}</p>` : ''}
      ${isApproved ? '<p>The amount has been credited to your wallet balance.</p>' : '<p>If you have questions, please contact support.</p>'}
    `),
  })
}

// Admin: new withdrawal request
async function sendWithdrawalRequestAlert({ adminEmail, userName, userEmail, amount, withdrawalId }) {
  const transporter = await createTransporter()
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || '"HopeBridge" <noreply@hopebridge.org>',
    to: adminEmail,
    subject: `[Withdrawal Request] $${amount} from ${userName}`,
    html: htmlWrap(`
      <h2>New Withdrawal Request 💸</h2>
      <p>A creator has requested a withdrawal:</p>
      <div class="highlight">
        <strong>User:</strong> ${userName} (${userEmail})<br>
        <strong>Amount:</strong> $${amount}<br>
        <strong>Request ID:</strong> #${withdrawalId}
      </div>
      <p>Please log in to the admin dashboard to approve or reject.</p>
    `),
  })
}

// User: withdrawal request status update (approved/rejected)
async function sendWithdrawalStatusEmail({ to, userName, amount, status, adminNote }) {
  const transporter = await createTransporter()
  const isApproved = status === 'approved' || status === 'paid'
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || '"HopeBridge" <noreply@hopebridge.org>',
    to,
    subject: `Your withdrawal request of $${amount} has been ${status}`,
    html: htmlWrap(`
      <h2>Withdrawal Request ${isApproved ? 'Approved ✅' : 'Rejected ❌'}</h2>
      <p>Dear <strong>${userName}</strong>,</p>
      <div class="highlight">
        <strong>Amount:</strong> $${amount}<br>
        <strong>Status:</strong> ${status.toUpperCase()}
      </div>
      ${adminNote ? `<p><strong>Admin note:</strong> ${adminNote}</p>` : ''}
      ${isApproved ? '<p>The funds have been deducted from your wallet and will be sent to your payment method.</p>' : ''}
    `),
  })
}

// ── Mass mail sender ─────────────────────────────────────────────
async function sendMassEmail({ transporter: t, to, subject, text }) {
  if (!t || !to || to.length === 0) throw new Error('Missing email parameters');

  const massTransporter = nodemailer.createTransport({
    host: t.host,
    port: t.port,
    secure: t.port === 465,
    auth: {
      user: t.user,
      pass: t.pass,
    },
  });

  await massTransporter.sendMail({
    from: `"HopeBridge" <${t.user}>`,
    bcc: to,
    subject,
    text: text.replace(/\n/g, '\n'),
    html: htmlWrap(`<p>${text.replace(/\n/g, '<br>')}</p>`),
  });
}

// ── Exports ──────────────────────────────────────────────────────
module.exports = {
  sendWelcomeEmail,
  sendDonationConfirmation,
  sendCampaignStatusEmail,
  sendNewCampaignAdminAlert,
  sendVerificationEmail,
  sendMassEmail,
  sendNewDonationAdminAlert,

  // Wallet alerts
  sendNewDepositRequestAlert,
  sendDepositStatusEmail,
  sendWithdrawalRequestAlert,
  sendWithdrawalStatusEmail,
}