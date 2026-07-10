const nodemailer = require('nodemailer');

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function createTransport() {
  if (!smtpConfigured()) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

function resolveFrom(userEmail) {
  const mode = String(process.env.SMTP_FROM_MODE || 'user_email').toLowerCase();
  if (mode === 'smtp_user') return process.env.SMTP_USER;
  return userEmail || process.env.SMTP_USER;
}

async function sendMail({ fromEmail, to, subject, html, text, replyTo }) {
  const transport = createTransport();
  if (!transport) throw new Error('SMTP is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in .env.');
  const from = resolveFrom(fromEmail);
  return transport.sendMail({
    from,
    to,
    subject,
    html,
    text: text || html?.replace(/<[^>]+>/g, ' '),
    replyTo: replyTo || fromEmail || from
  });
}

module.exports = { sendMail, smtpConfigured };
