const nodemailer = require('nodemailer')

// ── Transporter ──────────────────────────────────
// Reads directly from env vars — no DB lookup.
// Set these in Koyeb:
//   SMTP_HOST  = smtp.sendgrid.net
//   SMTP_PORT  = 587
//   SMTP_USER  = apikey
//   SMTP_PASS  = SG.xxxxxxxxxxxxxxxx
//   FROM_EMAIL = your_verified_sender@gmail.com
const createTransporter = () =>
  nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.sendgrid.net',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false, // TLS on port 587
    auth: {
      user: process.env.SMTP_USER || 'apikey',
      pass: process.env.SMTP_PASS,
    },
  })

const FROM = process.env.FROM_EMAIL || process.env.SMTP_USER || 'noreply@hopebridge.org'

// ── Core send helper ─────────────────────────────
async function send({ to, subject, html }) {
  try {
    const transporter = createTransporter()
    await transporter.sendMail({ from: `"HopeBridge" <${FROM}>`, to, subject, html })
    console.log(`📧 Email sent to ${to}: ${subject}`)
  } catch (err) {
    // Never crash the app over a failed email
    console.error('❌ Email failed:', err.message)
  }
}

// ── HTML wrapper ─────────────────────────────────
const htmlWrap = (body) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Open Sans', Arial, sans-serif; background: #f8f9fa; margin: 0; padding: 0; }
    .container { max-width: 580px; margin: 32px auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,.08); }
    .header { background: linear-gradient(135deg,#1D9E75,#0F6E56); padding: 32px 36px; color: #fff; }
    .header h1 { margin: 0; font-size: 1.5rem; }
    .header p  { margin: 6px 0 0; opacity: .85; font-size: .9rem; }
    .body { padding: 32px 36px; color: #444; line-height: 1.7; }
    .body h2 { color: #1a1a2e; margin-top: 0; }
    .highlight { background: rgba(29,158,117,.08); border-left: 4px solid #1D9E75; padding: 14px 18px; border-radius: 0 8px 8px 0; margin: 20px 0; }
    .btn { display: inline-block; background: linear-gradient(135deg,#1D9E75,#0F6E56); color: #fff !important; text-decoration: none; padding: 13px 28px; border-radius: 6px; font-weight: 700; margin-top: 12px; }
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

// ── Templates ────────────────────────────────────

async function sendWelcomeEmail({ to, name, role }) {
  await send({
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
  await send({
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
  const approved = status === 'approved'
  await send({
    to,
    subject: `Your campaign "${campaignTitle}" has been ${status}`,
    html: htmlWrap(`
      <h2>Campaign ${approved ? 'Approved! 🎉' : 'Not Approved'}</h2>
      <p>Dear <strong>${creatorName}</strong>,</p>
      <div class="highlight">
        Your campaign <strong>"${campaignTitle}"</strong> has been
        <strong style="color:${approved ? '#1D9E75' : '#E24B4A'}">${status.toUpperCase()}</strong>.
      </div>
      ${approved
        ? '<p>Your campaign is now live and visible to donors. Share it with your network to start raising funds!</p>'
        : '<p>Unfortunately your campaign did not meet our guidelines. Please review our campaign policy and feel free to submit a new one.</p>'
      }
    `),
  })
}

async function sendNewCampaignAdminAlert({ adminEmail, creatorName, campaignTitle, campaignId }) {
  await send({
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
  await send({
    to,
    subject: 'Your HopeBridge Verification Code',
    html: htmlWrap(`
      <h2>Hi ${name}!</h2>
      <p>Thank you for registering. Please enter the following code to verify your email address:</p>
      <div style="text-align:center; margin:24px 0;">
        <span style="font-size:2rem; font-weight:700; letter-spacing:6px; color:#1D9E75;">${code}</span>
      </div>
      <p>This code will expire in 15 minutes.</p>
    `),
  })
}

async function sendNewDonationAdminAlert({ adminEmail, donorName, amount, campaignTitle, campaignId, paymentMethod }) {
  await send({
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
      <p>Visit the <a href="${process.env.ADMIN_URL || 'https://hopebridge-inky.vercel.app/admin-dashboard'}" style="color:#1D9E75;">admin dashboard</a> to see all recent donations.</p>
    `),
  })
}

// ── Wallet alerts ────────────────────────────────

async function sendNewDepositRequestAlert({ adminEmail, userName, userEmail, amount, requestId }) {
  await send({
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

async function sendDepositStatusEmail({ to, userName, amount, status, adminNote }) {
  const isApproved = status === 'approved'
  await send({
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
      ${isApproved
        ? '<p>The amount has been credited to your wallet balance.</p>'
        : '<p>If you have questions, please contact support.</p>'
      }
    `),
  })
}

async function sendWithdrawalRequestAlert({ adminEmail, userName, userEmail, amount, withdrawalId }) {
  await send({
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

async function sendWithdrawalStatusEmail({ to, userName, amount, status, adminNote }) {
  const isApproved = status === 'approved' || status === 'paid'
  await send({
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

// ── Mass mail ────────────────────────────────────
async function sendMassEmail({ to, subject, text }) {
  if (!to || to.length === 0) throw new Error('No recipients provided')
  const html = htmlWrap(`<p>${text.replace(/\n/g, '<br>')}</p>`)
  for (const recipient of to) {
    await send({ to: recipient, subject, html })
  }
}

// ── Exports ──────────────────────────────────────
module.exports = {
  sendWelcomeEmail,
  sendDonationConfirmation,
  sendCampaignStatusEmail,
  sendNewCampaignAdminAlert,
  sendVerificationEmail,
  sendNewDonationAdminAlert,
  sendNewDepositRequestAlert,
  sendDepositStatusEmail,
  sendWithdrawalRequestAlert,
  sendWithdrawalStatusEmail,
  sendMassEmail,
}