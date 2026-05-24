const nodemailer = require('nodemailer')

// ── Transporter ──────────────────────────────────
// Now configured for Brevo (Sendinblue) SMTP
// Set these in Koyeb / .env:
//   SMTP_HOST  = smtp-relay.brevo.com
//   SMTP_PORT  = 587
//   SMTP_USER  = your_brevo_login_email@example.com
//   SMTP_PASS  = your_brevo_smtp_key
//   FROM_EMAIL = noreply@hopebridge.com
//   FROM_NAME  = HopeBridge
const createTransporter = () =>
  nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp-relay.brevo.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false, // TLS on port 587 (true for 465)
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: {
      rejectUnauthorized: false, // Required for some hosts
    },
    connectionTimeout: 10000, // 10 seconds
  })

const FROM_NAME = process.env.FROM_NAME || 'HopeBridge'
const FROM_EMAIL = process.env.FROM_EMAIL || process.env.SMTP_USER || 'noreply@hopebridge.com'
const FROM = `"${FROM_NAME}" <${FROM_EMAIL}>`

// ── Core send helper ─────────────────────────────
async function send({ to, subject, html }) {
  try {
    // Validate required fields
    if (!to) throw new Error('Recipient email is required')
    if (!subject) throw new Error('Email subject is required')
    if (!html) throw new Error('Email content is required')
    
    const transporter = createTransporter()
    const info = await transporter.sendMail({ 
      from: FROM, 
      to, 
      subject, 
      html,
      // Add tracking for Brevo (optional)
      headers: {
        'X-Message-ID': `hopebridge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      },
    })
    console.log(`📧 Email sent to ${to}: ${subject} (MessageId: ${info.messageId})`)
    return info
  } catch (err) {
    // Never crash the app over a failed email
    console.error('❌ Email failed to:', to, '-', err.message)
    if (err.response) console.error('   SMTP Response:', err.response)
    return null
  }
}

// ── HTML wrapper ─────────────────────────────────
const htmlWrap = (body) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HopeBridge Email</title>
  <style>
    body { font-family: 'Open Sans', Arial, sans-serif; background: #f8f9fa; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
    .container { max-width: 580px; margin: 32px auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,.08); }
    .header { background: linear-gradient(135deg,#1D9E75,#0F6E56); padding: 32px 36px; color: #fff; }
    .header h1 { margin: 0; font-size: 1.5rem; }
    .header p  { margin: 6px 0 0; opacity: .85; font-size: .9rem; }
    .body { padding: 32px 36px; color: #444; line-height: 1.7; }
    .body h2 { color: #1a1a2e; margin-top: 0; font-size: 1.4rem; }
    .body h3 { color: #1a1a2e; font-size: 1.1rem; margin: 20px 0 10px; }
    .highlight { background: rgba(29,158,117,.08); border-left: 4px solid #1D9E75; padding: 14px 18px; border-radius: 0 8px 8px 0; margin: 20px 0; }
    .btn { display: inline-block; background: linear-gradient(135deg,#1D9E75,#0F6E56); color: #fff !important; text-decoration: none; padding: 13px 28px; border-radius: 6px; font-weight: 700; margin-top: 12px; }
    .footer { background: #1a1a2e; padding: 20px 36px; color: rgba(255,255,255,.5); font-size: .82rem; text-align: center; }
    .footer a { color: rgba(255,255,255,.7); text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
    @media (max-width: 600px) {
      .header, .body, .footer { padding: 24px 20px; }
      .body h2 { font-size: 1.2rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>❤ HopeBridge</h1>
      <p>Empowering communities through transparent giving</p>
    </div>
    <div class="body">${body}</div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} HopeBridge · All Rights Reserved</p>
      <p><a href="${process.env.WEBSITE_URL || 'https://hopebridge.com'}">Visit our website</a></p>
    </div>
  </div>
</body>
</html>`

// ── Email Templates ────────────────────────────────────

async function sendWelcomeEmail({ to, name, role }) {
  return await send({
    to,
    subject: `Welcome to HopeBridge, ${name}! 🎉`,
    html: htmlWrap(`
      <h2>Welcome, ${name}!</h2>
      <p>Thank you for joining HopeBridge as a <strong>${role}</strong>.</p>
      <div class="highlight">
        <strong>Next step:</strong> ${role === 'creator' ? 'Create your first campaign' : 'Browse campaigns to support'} and start making an impact!
      </div>
      <p>Every contribution — no matter how small — makes a real difference in someone's life.</p>
      <p>Need help? Check out our <a href="${process.env.HELP_URL || '#'}" style="color:#1D9E75;">help center</a> or contact our support team.</p>
    `),
  })
}

async function sendDonationConfirmation({ to, donorName, amount, campaignTitle }) {
  return await send({
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
      <p>You can view your donation history and download receipts from your donor dashboard.</p>
      <p>With gratitude,<br>The HopeBridge Team ❤</p>
    `),
  })
}

async function sendCampaignStatusEmail({ to, creatorName, campaignTitle, status, reason }) {
  const approved = status === 'approved'
  return await send({
    to,
    subject: `Your campaign "${campaignTitle}" has been ${status}`,
    html: htmlWrap(`
      <h2>Campaign ${approved ? 'Approved! 🎉' : 'Update'}</h2>
      <p>Dear <strong>${creatorName}</strong>,</p>
      <div class="highlight">
        Your campaign <strong>"${campaignTitle}"</strong> has been
        <strong style="color:${approved ? '#1D9E75' : '#E24B4A'}">${status.toUpperCase()}</strong>.
      </div>
      ${approved 
        ? '<p>Your campaign is now live and visible to donors. Share it with your network to start raising funds!</p>'
        : `<p>${reason || 'Unfortunately your campaign did not meet our guidelines.'}<br><br>Please review our campaign policy and feel free to submit a new one.</p>`
      }
    `),
  })
}

async function sendNewCampaignAdminAlert({ adminEmail, creatorName, campaignTitle, campaignId }) {
  return await send({
    to: adminEmail,
    subject: `[Admin Alert] New campaign pending review: "${campaignTitle}"`,
    html: htmlWrap(`
      <h2>New Campaign Needs Review</h2>
      <p>A new campaign has been submitted and is awaiting your approval:</p>
      <div class="highlight">
        <strong>Title:</strong> ${campaignTitle}<br>
        <strong>Creator:</strong> ${creatorName}<br>
        <strong>Campaign ID:</strong> #${campaignId}
      </div>
      <p><a href="${process.env.ADMIN_URL || 'https://hopebridge-inky.vercel.app/admin-dashboard'}" class="btn">Go to Admin Dashboard</a></p>
      <p style="margin-top: 16px;">Please log in to review and approve or reject this campaign.</p>
    `),
  })
}

async function sendVerificationEmail({ to, name, code }) {
  return await send({
    to,
    subject: 'Your HopeBridge Verification Code',
    html: htmlWrap(`
      <h2>Hi ${name}!</h2>
      <p>Thank you for registering with HopeBridge. Please enter the following code to verify your email address:</p>
      <div style="text-align:center; margin:24px 0;">
        <span style="font-size:2rem; font-weight:700; letter-spacing:8px; color:#1D9E75; background:#f0fdf4; padding:16px 24px; border-radius:12px; display:inline-block;">${code}</span>
      </div>
      <p>This code will expire in <strong>15 minutes</strong>.</p>
      <p>If you didn't request this, please ignore this email.</p>
    `),
  })
}

async function sendNewDonationAdminAlert({ adminEmail, donorName, amount, campaignTitle, campaignId, paymentMethod }) {
  return await send({
    to: adminEmail,
    subject: `[Admin Alert] New Donation: $${amount} for "${campaignTitle}"`,
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
      <p><a href="${process.env.ADMIN_URL || 'https://hopebridge-inky.vercel.app/admin-dashboard'}" class="btn">View in Admin Dashboard</a></p>
    `),
  })
}

// ── Wallet alerts ────────────────────────────────

async function sendNewDepositRequestAlert({ adminEmail, userName, userEmail, amount, requestId, proofUploaded = false }) {
  return await send({
    to: adminEmail,
    subject: `[Admin Alert] ${proofUploaded ? 'Proof Uploaded for' : 'New'} Deposit Request: $${amount} from ${userName}`,
    html: htmlWrap(`
      <h2>${proofUploaded ? 'Payment Proof Uploaded 📎' : 'New Deposit Request 💰'}</h2>
      <p>A user has ${proofUploaded ? 'uploaded payment proof for their' : 'requested a'} wallet deposit:</p>
      <div class="highlight">
        <strong>User:</strong> ${userName} (${userEmail})<br>
        <strong>Amount:</strong> $${amount}<br>
        <strong>Request ID:</strong> #${requestId}
      </div>
      <p><a href="${process.env.ADMIN_URL || 'https://hopebridge-inky.vercel.app/admin-dashboard'}" class="btn">Review Request</a></p>
      <p>Please log in to the admin dashboard to process this request.</p>
    `),
  })
}

async function sendDepositStatusEmail({ to, userName, amount, status, adminNote, requestId }) {
  const isApproved = status === 'approved'
  const isInstructions = status === 'instructions_sent'
  return await send({
    to,
    subject: `Your deposit request of $${amount} has been ${isInstructions ? 'updated' : status}`,
    html: htmlWrap(`
      <h2>Deposit Request ${isApproved ? 'Approved ✅' : isInstructions ? 'Instructions Sent 📧' : 'Rejected ❌'}</h2>
      <p>Dear <strong>${userName}</strong>,</p>
      <div class="highlight">
        <strong>Amount:</strong> $${amount}<br>
        <strong>Status:</strong> ${status.toUpperCase()}
      </div>
      ${adminNote ? `<p><strong>${isInstructions ? 'Payment Instructions' : 'Admin Note'}:</strong><br>${adminNote.replace(/\n/g, '<br>')}</p>` : ''}
      ${isApproved 
        ? '<p>The amount has been credited to your wallet balance. You can now use these funds to donate to campaigns.</p>'
        : isInstructions
        ? '<p>Please follow the instructions above to complete your deposit. After making the payment, upload the proof in your wallet dashboard.</p>'
        : '<p>If you have questions, please contact our support team.</p>'
      }
    `),
  })
}

async function sendWithdrawalRequestAlert({ adminEmail, userName, userEmail, amount, withdrawalId }) {
  return await send({
    to: adminEmail,
    subject: `[Admin Alert] Withdrawal Request: $${amount} from ${userName}`,
    html: htmlWrap(`
      <h2>New Withdrawal Request 💸</h2>
      <p>A creator has requested a withdrawal:</p>
      <div class="highlight">
        <strong>User:</strong> ${userName} (${userEmail})<br>
        <strong>Amount:</strong> $${amount}<br>
        <strong>Request ID:</strong> #${withdrawalId}
      </div>
      <p><a href="${process.env.ADMIN_URL || 'https://hopebridge-inky.vercel.app/admin-dashboard'}" class="btn">Review Withdrawal</a></p>
      <p>Please log in to the admin dashboard to approve or reject this request.</p>
    `),
  })
}

async function sendWithdrawalStatusEmail({ to, userName, amount, status, adminNote }) {
  const isApproved = status === 'approved' || status === 'paid'
  return await send({
    to,
    subject: `Your withdrawal request of $${amount} has been ${status}`,
    html: htmlWrap(`
      <h2>Withdrawal Request ${isApproved ? 'Approved ✅' : 'Rejected ❌'}</h2>
      <p>Dear <strong>${userName}</strong>,</p>
      <div class="highlight">
        <strong>Amount:</strong> $${amount}<br>
        <strong>Status:</strong> ${status.toUpperCase()}
      </div>
      ${adminNote ? `<p><strong>Admin Note:</strong> ${adminNote}</p>` : ''}
      ${isApproved 
        ? '<p>The funds have been deducted from your wallet and will be sent to your registered payment method within 2-3 business days.</p>'
        : '<p>If you have questions about this decision, please contact our support team.</p>'
      }
    `),
  })
}

// ── Guest Donation Emails (NEW) ────────────────────────

async function sendGuestDonationInstructions({ to, guestName, amount, campaignTitle, instructions, donationId }) {
  const uploadLink = `${process.env.FRONTEND_URL || 'https://hopebridge-inky.vercel.app'}/guest-donation/upload/${donationId}`
  
  return await send({
    to,
    subject: `Payment Instructions for Your Donation to ${campaignTitle}`,
    html: htmlWrap(`
      <h2>Thank You for Your Generosity!</h2>
      <p>Dear <strong>${guestName || 'Valued Donor'}</strong>,</p>
      <p>Thank you for your generous donation of <strong>$${parseFloat(amount).toFixed(2)}</strong> to support <strong>${campaignTitle}</strong>.</p>
      
      <div class="highlight">
        <h3 style="margin: 0 0 10px 0;">📋 Payment Instructions</h3>
        <p style="white-space: pre-line; margin: 0;">${instructions.replace(/\n/g, '<br>')}</p>
      </div>
      
      <div style="background: #E8F5E9; padding: 15px; border-radius: 8px; margin: 20px 0;">
        <h3 style="margin-top: 0; color: #2D6A4F;">📌 Next Steps</h3>
        <ol style="margin-left: 20px; line-height: 1.6;">
          <li>Make the payment using the instructions above</li>
          <li>Keep your payment confirmation/screenshot</li>
          <li>Click the link below to upload your payment proof</li>
        </ol>
      </div>
      
      <p style="text-align: center;">
        <a href="${uploadLink}" class="btn">Upload Payment Proof</a>
      </p>
      
      <p style="margin-top: 20px; font-size: 12px; color: #666;">
        Donation Reference: #${donationId}<br>
        If you have any questions, please contact our support team at support@hopebridge.com
      </p>
    `),
  })
}

async function sendGuestDonationApproved({ to, guestName, amount, campaignTitle }) {
  return await send({
    to,
    subject: `Your Donation to ${campaignTitle} Has Been Confirmed! ✅`,
    html: htmlWrap(`
      <div style="text-align: center; margin-bottom: 20px;">
        <span style="font-size: 48px;">✅</span>
      </div>
      <h2 style="color: #2D6A4F; text-align: center;">Donation Confirmed!</h2>
      <p>Dear <strong>${guestName || 'Valued Donor'}</strong>,</p>
      <p>Great news! Your donation of <strong>$${parseFloat(amount).toFixed(2)}</strong> to <strong>${campaignTitle}</strong> has been verified and approved.</p>
      
      <div class="highlight" style="text-align: center;">
        <p style="margin: 0; font-size: 24px; font-weight: bold; color: #2D6A4F;">$${parseFloat(amount).toFixed(2)}</p>
        <p style="margin: 5px 0 0; color: #666;">Successfully Donated</p>
      </div>
      
      <p>Thank you for making a difference! Your support means the world to us and the cause you've chosen to support.</p>
      
      <p>With gratitude,<br>The HopeBridge Team ❤</p>
    `),
  })
}

async function sendGuestDonationRejected({ to, guestName, amount, campaignTitle, reason, donationId }) {
  return await send({
    to,
    subject: `Update Regarding Your Donation to ${campaignTitle}`,
    html: htmlWrap(`
      <div style="text-align: center; margin-bottom: 20px;">
        <span style="font-size: 48px;">⚠️</span>
      </div>
      <h2 style="color: #C45B3A; text-align: center;">Donation Payment Not Verified</h2>
      <p>Dear <strong>${guestName || 'Valued Donor'}</strong>,</p>
      <p>We were unable to verify your donation of <strong>$${parseFloat(amount).toFixed(2)}</strong> to <strong>${campaignTitle}</strong>.</p>
      
      <div class="highlight" style="background: #FDEBD4; border-left-color: #C45B3A;">
        <h3 style="margin-top: 0; color: #C45B3A;">Reason:</h3>
        <p>${reason || 'The payment proof provided could not be verified.'}</p>
      </div>
      
      <p>If you believe this is an error, please contact our support team with your payment reference number.</p>
      
      <p style="margin-top: 20px; font-size: 12px; color: #666;">
        Donation Reference: #${donationId}<br>
        Support Email: support@hopebridge.com
      </p>
    `),
  })
}

// ── Mass mail ────────────────────────────────────
async function sendMassEmail({ transporter: t, to, subject, text }) {
  if (!t || !to || to.length === 0) throw new Error('Missing email parameters');
  
  // Send individually to respect rate limits
  let successCount = 0;
  let failCount = 0;
  
  for (const recipient of to) {
    try {
      await send({ to: recipient, subject, html: htmlWrap(`<p>${text.replace(/\n/g, '<br>')}</p>`) });
      successCount++;
    } catch (err) {
      failCount++;
      console.error(`Failed to send to ${recipient}:`, err.message);
    }
    
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log(`📧 Mass mail completed: ${successCount} sent, ${failCount} failed`);
  return { successCount, failCount };
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
  // New guest donation exports
  sendGuestDonationInstructions,
  sendGuestDonationApproved,
  sendGuestDonationRejected,
}