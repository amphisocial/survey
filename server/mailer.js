const nodemailer = require('nodemailer');

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['true', '1', 'yes', 'y'].includes(String(value).toLowerCase());
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function safeHeloName() {
  return String(process.env.SMTP_HELO_NAME || 'survey.athenabot.ai')
    .replace(/[^a-zA-Z0-9.-]/g, '')
    .slice(0, 120) || 'survey.athenabot.ai';
}

function createTransport() {
  if (!smtpConfigured()) return null;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = bool(process.env.SMTP_SECURE, port === 465);

  return nodemailer.createTransport({
    host,
    port,
    secure,
    name: safeHeloName(),
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    requireTLS: bool(process.env.SMTP_REQUIRE_TLS, port === 587),
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT || 20000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT || 20000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT || 30000),
    logger: bool(process.env.SMTP_DEBUG, false),
    debug: bool(process.env.SMTP_DEBUG, false),
    tls: {
      servername: host,
      rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false'
    }
  });
}

function resolveFrom(userEmail) {
  const mode = String(process.env.SMTP_FROM_MODE || 'smtp_user').toLowerCase();
  if (mode === 'user_email') return userEmail || process.env.SMTP_USER;
  return process.env.SMTP_FROM || process.env.SMTP_USER;
}

async function sendMail({ fromEmail, to, subject, html, text, replyTo }) {
  const transport = createTransport();
  if (!transport) {
    throw new Error('SMTP is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in .env.');
  }

  return transport.sendMail({
    from: resolveFrom(fromEmail),
    to,
    subject,
    html,
    text: text || html?.replace(/<[^>]+>/g, ' '),
    replyTo: replyTo || fromEmail || process.env.SMTP_USER,
    disableFileAccess: true,
    disableUrlAccess: true
  });
}

module.exports = { sendMail, smtpConfigured };
