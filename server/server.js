/*
 * Athena Survey
 * Web-based live survey/poll app with Google Auth, Postgres, Stripe, SMTP, QR links, Socket.IO live results, and AI survey generation.
 */
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { query, tx } = require('./db');
const { sendMail } = require('./mailer');
const { generateSurveyDraft, analyzeResults, tagCloudFromTexts } = require('./ai');

const PORT = Number(process.env.PORT || 3010);
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'athena_survey_session';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-session-secret';
const NODE_ENV = process.env.NODE_ENV || 'development';
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const STRIPE_PRICE_ENTERPRISE = process.env.STRIPE_PRICE_ENTERPRISE || process.env.STRIPE_PRICE_ENTERPRISE_STARTER;
// Basic is intentionally free. Set ENABLE_FREE_BASIC=false only if you want to temporarily disable all free creation.
const FREE_BASIC_ENABLED = process.env.ENABLE_FREE_BASIC !== 'false';

const PLAN_LIMITS = {
  basic: { label: 'Basic', surveysPerMonth: Number(process.env.BASIC_MONTHLY_SURVEY_LIMIT || 5), userLimit: 1 },
  pro: { label: 'Pro', surveysPerMonth: Number(process.env.PRO_MONTHLY_SURVEY_LIMIT || 999999), userLimit: 1 },
  enterprise: { label: 'Enterprise', surveysPerMonth: Number(process.env.PRO_MONTHLY_SURVEY_LIMIT || 999999), userLimit: Number(process.env.ENTERPRISE_STARTING_USER_LIMIT || 10) }
};

const STRIPE_PRICE_TO_PLAN = Object.fromEntries([
  [process.env.STRIPE_PRICE_BASIC, 'basic'],
  [process.env.STRIPE_PRICE_PRO, 'pro'],
  [STRIPE_PRICE_ENTERPRISE, 'enterprise']
].filter(([price]) => Boolean(price)));

function nowIso() { return new Date().toISOString(); }
function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }
function token(bytes = Number(process.env.PUBLIC_LINK_TOKEN_BYTES || 32)) { return crypto.randomBytes(bytes).toString('base64url'); }
function appAdminEmails() { return String(process.env.APP_ADMIN_EMAILS || '').split(',').map(normalizeEmail).filter(Boolean); }
function isAppAdminEmail(email) { return appAdminEmails().includes(normalizeEmail(email)); }
function stripHtml(text) { return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function escapeHtmlServer(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function monthStartIso(date = new Date()) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString(); }
function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function publicUser(user, subscription = null, memberships = []) {
  if (!user) return null;
  const plan = subscription?.plan || (FREE_BASIC_ENABLED ? 'basic' : 'none');
  return {
    id: user.id,
    email: user.email,
    name: user.name || user.email,
    avatarUrl: user.avatar_url,
    roleGlobal: user.role_global,
    isAppAdmin: user.role_global === 'app_admin',
    plan,
    planLabel: PLAN_LIMITS[plan]?.label || 'No plan',
    subscriptionStatus: subscription?.status || (FREE_BASIC_ENABLED ? 'basic_free' : 'inactive'),
    limits: PLAN_LIMITS[plan] || { surveysPerMonth: 0, userLimit: 1 },
    memberships
  };
}

async function getSubscriptionForUser(userId) {
  const result = await query(`
    SELECT * FROM subscriptions
    WHERE owner_user_id = $1
    ORDER BY updated_at DESC NULLS LAST, created_at DESC
    LIMIT 1
  `, [userId]);
  if (result.rows[0]) return result.rows[0];
  if (FREE_BASIC_ENABLED) return { owner_user_id: userId, plan: 'basic', status: 'active', is_free_default: true };
  return null;
}

async function getMemberships(userId, email) {
  const result = await query(`
    SELECT om.*, o.name AS organization_name, o.plan, o.max_active_users
    FROM organization_members om
    JOIN organizations o ON o.id = om.organization_id
    WHERE (om.user_id = $1 OR lower(om.email) = lower($2))
    ORDER BY om.invited_at DESC
  `, [userId, email]);
  return result.rows;
}

async function currentUser(req) {
  const sessionToken = req.cookies?.[COOKIE_NAME];
  if (!sessionToken) return null;
  const result = await query(`
    SELECT u.* FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = $1 AND s.expires_at > now()
  `, [sessionToken]);
  return result.rows[0] || null;
}

async function requireUser(req, res, next) {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'Please sign in first.' });
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

async function requireAppAdmin(req, res, next) {
  await requireUser(req, res, () => {
    if (req.user.role_global !== 'app_admin') return res.status(403).json({ error: 'Application admin access required.' });
    next();
  });
}

async function requireSurveyOwner(req, res, next) {
  try {
    const surveyId = req.params.id || req.params.surveyId;
    if (!isUuid(surveyId)) return res.status(400).json({ error: 'Invalid or missing survey id.' });
    const result = await query('SELECT * FROM surveys WHERE id = $1', [surveyId]);
    const survey = result.rows[0];
    if (!survey) return res.status(404).json({ error: 'Survey not found.' });
    if (survey.owner_user_id !== req.user.id && req.user.role_global !== 'app_admin') {
      return res.status(403).json({ error: 'You do not have access to this survey.' });
    }
    req.survey = survey;
    next();
  } catch (error) { next(error); }
}

async function createSession(res, userId) {
  const sessionToken = token(32);
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  await query('DELETE FROM sessions WHERE user_id = $1 OR expires_at <= now()', [userId]);
  await query('INSERT INTO sessions(token, user_id, expires_at) VALUES($1, $2, $3)', [sessionToken, userId, expiresAt]);
  res.cookie(COOKIE_NAME, sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30,
    path: '/'
  });
}

async function upsertGoogleUser(profile) {
  const email = normalizeEmail(profile.email);
  if (!email) throw new Error('Google profile did not include an email address.');
  const role = isAppAdminEmail(email) ? 'app_admin' : 'user';
  const result = await query(`
    INSERT INTO users(email, name, google_sub, avatar_url, role_global)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (email) DO UPDATE SET
      name = COALESCE(EXCLUDED.name, users.name),
      google_sub = COALESCE(EXCLUDED.google_sub, users.google_sub),
      avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
      role_global = CASE WHEN users.role_global = 'app_admin' OR EXCLUDED.role_global = 'app_admin' THEN 'app_admin' ELSE users.role_global END,
      updated_at = now()
    RETURNING *
  `, [email, profile.name || email, profile.sub || null, profile.picture || null, role]);
  const user = result.rows[0];
  await query(`
    UPDATE organization_members
    SET user_id = $1, status = CASE WHEN status = 'invited' THEN 'active' ELSE status END, joined_at = COALESCE(joined_at, now())
    WHERE lower(email) = lower($2) AND user_id IS NULL
  `, [user.id, email]);
  return user;
}

async function canCreateSurvey(user) {
  if (user.role_global === 'app_admin') return { ok: true, used: 0, limit: 999999, plan: 'app_admin' };
  const sub = await getSubscriptionForUser(user.id);
  const plan = sub?.plan || 'none';
  const limit = PLAN_LIMITS[plan]?.surveysPerMonth || 0;
  const status = sub?.status || 'inactive';
  const active = ['active', 'trialing', 'basic_enabled', 'basic_free'].includes(status) || (FREE_BASIC_ENABLED && plan === 'basic');
  const usage = await query('SELECT count(*)::int AS count FROM surveys WHERE owner_user_id = $1 AND created_at >= $2', [user.id, monthStartIso()]);
  const used = usage.rows[0]?.count || 0;
  return { ok: active && used < limit, used, limit, remaining: Math.max(0, limit - used), plan, status };
}

async function assertEnterpriseCreator(user, organizationId) {
  if (!organizationId) return;
  const result = await query(`
    SELECT om.*, o.max_active_users, o.status FROM organization_members om
    JOIN organizations o ON o.id = om.organization_id
    WHERE om.organization_id = $1 AND om.user_id = $2 AND om.status = 'active' AND om.role IN ('owner','admin','creator')
  `, [organizationId, user.id]);
  if (!result.rows[0] && user.role_global !== 'app_admin') throw new Error('You are not an active creator in this organization.');
}

async function getQuestionWithOptions(questionId) {
  const q = await query('SELECT * FROM survey_questions WHERE id = $1', [questionId]);
  const question = q.rows[0];
  if (!question) return null;
  const opts = await query('SELECT * FROM question_options WHERE question_id = $1 AND is_active = true ORDER BY display_order, created_at', [questionId]);
  return { ...question, options: opts.rows };
}

async function calculateQuestionResults(questionId) {
  const question = await getQuestionWithOptions(questionId);
  if (!question) return null;
  const responseCount = await query('SELECT count(*)::int AS count FROM responses WHERE question_id = $1', [questionId]);
  if (question.question_type === 'tag_cloud') {
    const answers = await query(`
      SELECT ra.text_answer FROM response_answers ra
      JOIN responses r ON r.id = ra.response_id
      WHERE r.question_id = $1 AND ra.text_answer IS NOT NULL
      ORDER BY r.submitted_at DESC
    `, [questionId]);
    const texts = answers.rows.map((r) => r.text_answer).filter(Boolean);
    return { question, responseCount: responseCount.rows[0].count, tags: tagCloudFromTexts(texts), rawText: texts.slice(0, 200) };
  }
  const counts = await query(`
    SELECT qo.id, qo.option_text, qo.display_order, count(ra.id)::int AS count
    FROM question_options qo
    LEFT JOIN response_answers ra ON ra.option_id = qo.id
    WHERE qo.question_id = $1 AND qo.is_active = true
    GROUP BY qo.id, qo.option_text, qo.display_order
    ORDER BY qo.display_order, qo.option_text
  `, [questionId]);
  const total = counts.rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  return {
    question,
    responseCount: responseCount.rows[0].count,
    totalSelections: total,
    options: counts.rows.map((row) => ({ ...row, pct: total ? Math.round((row.count / total) * 1000) / 10 : 0 }))
  };
}

async function broadcastQuestionResults(io, questionId) {
  const results = await calculateQuestionResults(questionId);
  if (!results) return;
  io.to(`question:${questionId}`).emit('results:updated', results);
  io.to(`survey:${results.question.survey_id}`).emit('results:updated', results);
}

function questionPublicUrl(link) {
  if (link.scope === 'question') return `${APP_BASE_URL}/q/${link.token}`;
  if (link.scope === 'live_results') return `${APP_BASE_URL}/live/${link.token}`;
  return `${APP_BASE_URL}/s/${link.token}`;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 240 }));
app.use(cookieParser());

app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(400).send('Stripe is not configured.');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return res.status(400).send(`Webhook signature failed: ${error.message}`);
  }
  try {
    const obj = event.data.object;
    if (event.type === 'checkout.session.completed') {
      const plan = obj.metadata?.plan;
      const userId = obj.metadata?.userId || null;
      const organizationId = obj.metadata?.organizationId || null;
      if (plan && (userId || organizationId)) {
        await query(`
          INSERT INTO subscriptions(owner_user_id, organization_id, plan, status, stripe_customer_id, stripe_subscription_id, updated_at)
          VALUES($1, $2, $3, 'active', $4, $5, now())
          ON CONFLICT DO NOTHING
        `, [userId, organizationId, plan, obj.customer, obj.subscription]);
        await query(`
          UPDATE subscriptions SET plan=$1, status='active', stripe_customer_id=$2, stripe_subscription_id=$3, updated_at=now()
          WHERE (owner_user_id = $4 OR organization_id = $5)
        `, [plan, obj.customer, obj.subscription, userId, organizationId]);
      }
    }
    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
      const sub = obj;
      const priceId = sub.items?.data?.[0]?.price?.id;
      const plan = STRIPE_PRICE_TO_PLAN[priceId] || sub.metadata?.plan;
      await query(`
        UPDATE subscriptions SET plan=COALESCE($1, plan), status=$2, current_period_start=to_timestamp($3), current_period_end=to_timestamp($4), updated_at=now()
        WHERE stripe_subscription_id=$5 OR stripe_customer_id=$6
      `, [plan, sub.status, sub.current_period_start || null, sub.current_period_end || null, sub.id, sub.customer]);
    }
    if (event.type === 'customer.subscription.deleted') {
      await query(`UPDATE subscriptions SET status='canceled', updated_at=now() WHERE stripe_subscription_id=$1`, [obj.id]);
    }
    res.json({ received: true });
  } catch (error) {
    console.error('[stripe:webhook]', error);
    res.status(500).send('Webhook handler failed.');
  }
});

app.use(express.json({ limit: '4mb' }));
app.use(express.static(PUBLIC_DIR));

io.on('connection', (socket) => {
  socket.on('join:survey', (surveyId) => { if (surveyId) socket.join(`survey:${surveyId}`); });
  socket.on('join:question', (questionId) => { if (questionId) socket.join(`question:${questionId}`); });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', app: 'athena-survey', time: nowIso() }));

app.get('/api/me', async (req, res, next) => {
  try {
    const user = await currentUser(req);
    if (!user) return res.json({ user: null });
    const subscription = await getSubscriptionForUser(user.id);
    const memberships = await getMemberships(user.id, user.email);
    const usage = await canCreateSurvey(user);
    res.json({ user: publicUser(user, subscription, memberships), usage });
  } catch (error) { next(error); }
});

app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(400).send('Google OAuth is not configured yet. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.');
  }
  const state = crypto.createHmac('sha256', SESSION_SECRET).update(token(16)).digest('hex');
  res.cookie('athena_survey_google_state', state, { httpOnly: true, sameSite: 'lax', secure: NODE_ENV === 'production', maxAge: 1000 * 60 * 10, path: '/' });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${APP_BASE_URL}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account'
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const expected = req.cookies?.athena_survey_google_state;
    if (!expected || expected !== req.query.state) throw new Error('Invalid OAuth state.');
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code: req.query.code,
        grant_type: 'authorization_code',
        redirect_uri: `${APP_BASE_URL}/auth/google/callback`
      })
    });
    const tokenPayload = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error(tokenPayload.error_description || 'Google token exchange failed.');
    const profileResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenPayload.access_token}` }
    });
    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.email) throw new Error('Could not read Google profile.');
    const user = await upsertGoogleUser(profile);
    await createSession(res, user.id);
    res.clearCookie('athena_survey_google_state', { path: '/' });
    res.redirect('/app.html?signedIn=google');
  } catch (error) {
    console.error('[google:callback]', error);
    res.redirect(`/?googleError=${encodeURIComponent(error.message)}`);
  }
});

app.post('/api/auth/logout', requireUser, async (req, res, next) => {
  try {
    const t = req.cookies?.[COOKIE_NAME];
    if (t) await query('DELETE FROM sessions WHERE token=$1', [t]);
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/contact', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 100);
    const email = normalizeEmail(req.body.email);
    const message = String(req.body.message || '').trim().slice(0, 5000);
    if (!email || !message) return res.status(400).json({ error: 'Email and message are required.' });
    const to = process.env.CONTACT_FORM_TO || 'anu@threadwire.ai';
    await sendMail({
      fromEmail: email,
      to,
      subject: `Athena Survey contact form from ${name || email}`,
      html: `<p><strong>Name:</strong> ${name || 'Not provided'}</p><p><strong>Email:</strong> ${email}</p><p>${message.replace(/\n/g, '<br>')}</p>`,
      replyTo: email
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/ai/survey-draft', requireUser, async (req, res, next) => {
  try {
    const input = {
      topic: String(req.body.topic || '').trim().slice(0, 300),
      description: String(req.body.description || '').trim().slice(0, 4000),
      audience: String(req.body.audience || '').trim().slice(0, 300),
      goal: String(req.body.goal || '').trim().slice(0, 300),
      transcript: Array.isArray(req.body.messages) ? req.body.messages.map((m) => `${m.role}: ${m.content}`).join('\n') : ''
    };
    const result = await generateSurveyDraft(input);
    await query('INSERT INTO ai_runs(user_id, run_type, input_json, output_json, model) VALUES($1,$2,$3,$4,$5)', [req.user.id, 'survey_builder', input, result.parsed, result.provider]);
    res.json({ draft: result.parsed, provider: result.provider });
  } catch (error) { next(error); }
});

app.get('/api/surveys', requireUser, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT s.*, count(DISTINCT q.id)::int AS question_count, count(DISTINCT r.id)::int AS response_count
      FROM surveys s
      LEFT JOIN survey_questions q ON q.survey_id = s.id
      LEFT JOIN responses r ON r.survey_id = s.id
      WHERE s.owner_user_id = $1 OR $2 = 'app_admin'
      GROUP BY s.id
      ORDER BY s.updated_at DESC, s.created_at DESC
    `, [req.user.id, req.user.role_global]);
    res.json({ surveys: result.rows });
  } catch (error) { next(error); }
});

app.post('/api/surveys', requireUser, async (req, res, next) => {
  try {
    const usage = await canCreateSurvey(req.user);
    if (!usage.ok) return res.status(429).json({ error: usage.plan === 'basic' ? `Basic includes ${usage.limit} surveys per month. You have used ${usage.used}. Upgrade to Pro for unlimited surveys.` : `Survey limit reached or subscription inactive. Current plan: ${usage.plan}.`, usage });
    const organizationId = req.body.organizationId || null;
    await assertEnterpriseCreator(req.user, organizationId);
    const title = String(req.body.title || 'Untitled Survey').trim().slice(0, 120);
    const description = String(req.body.description || '').trim().slice(0, 1000);
    const aiPrompt = String(req.body.aiPrompt || '').trim().slice(0, 4000);
    const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
    const survey = await tx(async (client) => {
      const created = await client.query(`
        INSERT INTO surveys(owner_user_id, organization_id, title, description, created_by_ai, ai_prompt)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *
      `, [req.user.id, organizationId, title, description, Boolean(req.body.createdByAi), aiPrompt]);
      const surveyRow = created.rows[0];
      for (let i = 0; i < questions.length; i += 1) {
        const q = questions[i];
        const type = ['single_choice','multi_select','tag_cloud'].includes(q.type) ? q.type : 'single_choice';
        const qr = await client.query(`
          INSERT INTO survey_questions(survey_id, question_text, question_type, display_order, allow_other)
          VALUES($1,$2,$3,$4,$5) RETURNING *
        `, [surveyRow.id, String(q.question || q.question_text || '').trim().slice(0, 300), type, i + 1, Boolean(q.allowOther)]);
        const opts = Array.isArray(q.options) ? q.options : [];
        for (let j = 0; j < opts.length; j += 1) {
          const text = String(opts[j].option_text || opts[j]).trim().slice(0, 120);
          if (text) await client.query('INSERT INTO question_options(question_id, option_text, display_order) VALUES($1,$2,$3)', [qr.rows[0].id, text, j + 1]);
        }
      }
      return surveyRow;
    });
    res.json({ survey, usage: await canCreateSurvey(req.user) });
  } catch (error) { next(error); }
});

app.get('/api/surveys/:id', requireUser, requireSurveyOwner, async (req, res, next) => {
  try {
    const questions = await query('SELECT * FROM survey_questions WHERE survey_id=$1 ORDER BY display_order, created_at', [req.survey.id]);
    const qIds = questions.rows.map((q) => q.id);
    const options = qIds.length ? await query('SELECT * FROM question_options WHERE question_id = ANY($1::uuid[]) ORDER BY display_order, created_at', [qIds]) : { rows: [] };
    const links = await query('SELECT *, NULL AS qr FROM survey_share_links WHERE survey_id=$1 ORDER BY created_at DESC', [req.survey.id]);
    res.json({ survey: req.survey, questions: questions.rows, options: options.rows, links: links.rows });
  } catch (error) { next(error); }
});

app.patch('/api/surveys/:id', requireUser, requireSurveyOwner, async (req, res, next) => {
  try {
    const result = await query(`
      UPDATE surveys SET title=COALESCE($1,title), description=COALESCE($2,description), allow_anonymous=COALESCE($3,allow_anonymous), show_live_results=COALESCE($4,show_live_results), updated_at=now()
      WHERE id=$5 RETURNING *
    `, [req.body.title ?? null, req.body.description ?? null, req.body.allowAnonymous ?? null, req.body.showLiveResults ?? null, req.survey.id]);
    res.json({ survey: result.rows[0] });
  } catch (error) { next(error); }
});

async function updateSurveyStatus(req, res, status) {
  const payload = await tx(async (client) => {
    const surveyResult = await client.query(`
      UPDATE surveys
      SET
        status = $1,
        closed_at = CASE WHEN $1 = 'closed' THEN now() ELSE closed_at END,
        current_active_question_id = CASE WHEN $1 = 'closed' THEN NULL ELSE current_active_question_id END,
        updated_at = now()
      WHERE id = $2
      RETURNING *
    `, [status, req.survey.id]);

    let completedQuestions = [];
    if (status === 'closed') {
      const questionResult = await client.query(`
        UPDATE survey_questions
        SET
          status = 'completed',
          completed_at = COALESCE(completed_at, now()),
          updated_at = now()
        WHERE survey_id = $1
          AND status <> 'completed'
        RETURNING *
      `, [req.survey.id]);
      completedQuestions = questionResult.rows;
    }

    return {
      survey: surveyResult.rows[0],
      completedQuestions
    };
  });

  io.to(`survey:${req.survey.id}`).emit('survey:status', payload.survey);

  if (status === 'closed') {
    io.to(`survey:${req.survey.id}`).emit('question:activated', null);
    for (const question of payload.completedQuestions) {
      io.to(`survey:${req.survey.id}`).emit('question:status', question);
      await broadcastQuestionResults(io, question.id);
    }
  }

  res.json(payload);
}
app.post('/api/surveys/:id/activate', requireUser, requireSurveyOwner, (req, res, next) => updateSurveyStatus(req, res, 'active').catch(next));
app.post('/api/surveys/:id/inactivate', requireUser, requireSurveyOwner, (req, res, next) => updateSurveyStatus(req, res, 'inactive').catch(next));
app.post('/api/surveys/:id/close', requireUser, requireSurveyOwner, (req, res, next) => updateSurveyStatus(req, res, 'closed').catch(next));

app.post('/api/surveys/:id/questions', requireUser, requireSurveyOwner, async (req, res, next) => {
  try {
    const type = ['single_choice','multi_select','tag_cloud'].includes(req.body.questionType || req.body.type) ? (req.body.questionType || req.body.type) : 'single_choice';
    const count = await query('SELECT COALESCE(max(display_order),0)+1 AS next_order FROM survey_questions WHERE survey_id=$1', [req.survey.id]);
    const q = await query(`
      INSERT INTO survey_questions(survey_id, question_text, question_type, display_order, allow_other)
      VALUES($1,$2,$3,$4,$5) RETURNING *
    `, [req.survey.id, String(req.body.questionText || req.body.question || '').trim().slice(0, 300), type, count.rows[0].next_order, Boolean(req.body.allowOther)]);
    const question = q.rows[0];
    const opts = Array.isArray(req.body.options) ? req.body.options : [];
    for (let i = 0; i < opts.length; i += 1) {
      const text = String(opts[i]).trim().slice(0, 120);
      if (text) await query('INSERT INTO question_options(question_id, option_text, display_order) VALUES($1,$2,$3)', [question.id, text, i + 1]);
    }
    res.json({ question });
  } catch (error) { next(error); }
});

app.patch('/api/questions/:questionId', requireUser, async (req, res, next) => {
  try {
    const q = await query('SELECT q.*, s.owner_user_id FROM survey_questions q JOIN surveys s ON s.id=q.survey_id WHERE q.id=$1', [req.params.questionId]);
    const question = q.rows[0];
    if (!question) return res.status(404).json({ error: 'Question not found.' });
    if (question.owner_user_id !== req.user.id && req.user.role_global !== 'app_admin') return res.status(403).json({ error: 'No access.' });
    const updated = await tx(async (client) => {
      const ur = await client.query(`
        UPDATE survey_questions SET question_text=COALESCE($1,question_text), question_type=COALESCE($2,question_type), allow_other=COALESCE($3,allow_other), show_results=COALESCE($4,show_results), updated_at=now()
        WHERE id=$5 RETURNING *
      `, [req.body.questionText ?? null, req.body.questionType ?? null, req.body.allowOther ?? null, req.body.showResults ?? null, req.params.questionId]);
      if (Array.isArray(req.body.options)) {
        await client.query('DELETE FROM question_options WHERE question_id=$1', [req.params.questionId]);
        for (let i = 0; i < req.body.options.length; i += 1) {
          const text = String(req.body.options[i]).trim().slice(0, 120);
          if (text) await client.query('INSERT INTO question_options(question_id, option_text, display_order) VALUES($1,$2,$3)', [req.params.questionId, text, i + 1]);
        }
      }
      return ur.rows[0];
    });
    await broadcastQuestionResults(io, req.params.questionId);
    res.json({ question: updated });
  } catch (error) { next(error); }
});

async function setQuestionStatus(questionId, user, status) {
  return tx(async (client) => {
    const q = await client.query('SELECT q.*, s.owner_user_id FROM survey_questions q JOIN surveys s ON s.id=q.survey_id WHERE q.id=$1', [questionId]);
    const question = q.rows[0];
    if (!question) throw new Error('Question not found.');
    if (question.owner_user_id !== user.id && user.role_global !== 'app_admin') throw new Error('No access.');
    if (status === 'active') {
      await client.query(`UPDATE survey_questions SET status='inactive', updated_at=now() WHERE survey_id=$1 AND id <> $2 AND status='active'`, [question.survey_id, questionId]);
      await client.query(`UPDATE surveys SET status='active', current_active_question_id=$1, updated_at=now() WHERE id=$2`, [questionId, question.survey_id]);
    }
    const result = await client.query(`
      UPDATE survey_questions SET status=$1, activated_at=CASE WHEN $1='active' THEN now() ELSE activated_at END, completed_at=CASE WHEN $1 IN ('completed','closed') THEN now() ELSE completed_at END, updated_at=now()
      WHERE id=$2 RETURNING *
    `, [status, questionId]);
    if (status !== 'active') {
      await client.query(`UPDATE surveys SET current_active_question_id = CASE WHEN current_active_question_id=$1 THEN NULL ELSE current_active_question_id END, updated_at=now() WHERE id=$2`, [questionId, question.survey_id]);
    }
    return result.rows[0];
  });
}

function questionStatusRoute(status) {
  return async (req, res, next) => {
    try {
      const question = await setQuestionStatus(req.params.questionId, req.user, status);
      io.to(`survey:${question.survey_id}`).emit('question:status', question);
      if (status === 'active') io.to(`survey:${question.survey_id}`).emit('question:activated', question);
      await broadcastQuestionResults(io, question.id);
      res.json({ question });
    } catch (error) { next(error); }
  };
}
app.post('/api/questions/:questionId/activate', requireUser, questionStatusRoute('active'));
app.post('/api/questions/:questionId/inactivate', requireUser, questionStatusRoute('inactive'));
app.post('/api/questions/:questionId/complete', requireUser, questionStatusRoute('completed'));
app.post('/api/questions/:questionId/close', requireUser, questionStatusRoute('closed'));

app.post('/api/surveys/:id/share-link', requireUser, requireSurveyOwner, async (req, res, next) => {
  try {
    const scope = ['survey','live_results'].includes(req.body.scope) ? req.body.scope : 'survey';
    const versionResult = await query('SELECT COALESCE(max(version),0)+1 AS version FROM survey_share_links WHERE survey_id=$1 AND scope=$2', [req.survey.id, scope]);
    const link = await query(`
      INSERT INTO survey_share_links(survey_id, token, version, scope) VALUES($1,$2,$3,$4) RETURNING *
    `, [req.survey.id, token(), versionResult.rows[0].version, scope]);
    const url = questionPublicUrl(link.rows[0]);
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 360 });
    res.json({ link: link.rows[0], url, qr });
  } catch (error) { next(error); }
});

app.post('/api/questions/:questionId/share-link', requireUser, async (req, res, next) => {
  try {
    const q = await query('SELECT q.*, s.owner_user_id FROM survey_questions q JOIN surveys s ON s.id=q.survey_id WHERE q.id=$1', [req.params.questionId]);
    const question = q.rows[0];
    if (!question) return res.status(404).json({ error: 'Question not found.' });
    if (question.owner_user_id !== req.user.id && req.user.role_global !== 'app_admin') return res.status(403).json({ error: 'No access.' });
    const versionResult = await query('SELECT COALESCE(max(version),0)+1 AS version FROM survey_share_links WHERE question_id=$1 AND scope=$2', [question.id, 'question']);
    const link = await query(`INSERT INTO survey_share_links(survey_id, question_id, token, version, scope) VALUES($1,$2,$3,$4,'question') RETURNING *`, [question.survey_id, question.id, token(), versionResult.rows[0].version]);
    const url = questionPublicUrl(link.rows[0]);
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 360 });
    res.json({ link: link.rows[0], url, qr });
  } catch (error) { next(error); }
});

app.post('/api/share-links/:linkId/revoke', requireUser, async (req, res, next) => {
  try {
    const link = await query('SELECT l.*, s.owner_user_id FROM survey_share_links l JOIN surveys s ON s.id=l.survey_id WHERE l.id=$1', [req.params.linkId]);
    const row = link.rows[0];
    if (!row) return res.status(404).json({ error: 'Link not found.' });
    if (row.owner_user_id !== req.user.id && req.user.role_global !== 'app_admin') return res.status(403).json({ error: 'No access.' });
    const updated = await query('UPDATE survey_share_links SET is_active=false, revoked_at=now() WHERE id=$1 RETURNING *', [req.params.linkId]);
    res.json({ link: updated.rows[0] });
  } catch (error) { next(error); }
});

app.post('/api/share-links/:linkId/regenerate', requireUser, async (req, res, next) => {
  try {
    const link = await query('SELECT l.*, s.owner_user_id FROM survey_share_links l JOIN surveys s ON s.id=l.survey_id WHERE l.id=$1', [req.params.linkId]);
    const row = link.rows[0];
    if (!row) return res.status(404).json({ error: 'Link not found.' });
    if (row.owner_user_id !== req.user.id && req.user.role_global !== 'app_admin') return res.status(403).json({ error: 'No access.' });
    await query('UPDATE survey_share_links SET is_active=false, revoked_at=now() WHERE id=$1', [row.id]);
    const nextVersion = await query('SELECT COALESCE(max(version),0)+1 AS version FROM survey_share_links WHERE survey_id=$1 AND scope=$2', [row.survey_id, row.scope]);
    const created = await query('INSERT INTO survey_share_links(survey_id, question_id, token, version, scope) VALUES($1,$2,$3,$4,$5) RETURNING *', [row.survey_id, row.question_id, token(), nextVersion.rows[0].version, row.scope]);
    const url = questionPublicUrl(created.rows[0]);
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 360 });
    res.json({ link: created.rows[0], url, qr });
  } catch (error) { next(error); }
});

async function loadPublicLink(tokenValue, scopeExpected = null) {
  const result = await query(`
    SELECT l.*, s.title, s.description, s.status AS survey_status, s.current_active_question_id, s.show_live_results, s.allow_anonymous
    FROM survey_share_links l
    JOIN surveys s ON s.id = l.survey_id
    WHERE l.token = $1 AND l.is_active = true
  `, [tokenValue]);
  const link = result.rows[0];
  if (!link) return null;
  if (scopeExpected && link.scope !== scopeExpected) return null;
  return link;
}

app.get('/api/public/survey/:token', async (req, res, next) => {
  try {
    const link = await loadPublicLink(req.params.token, 'survey');
    if (!link) return res.status(404).json({ error: 'Survey link is no longer active.' });
    if (!['active','draft'].includes(link.survey_status)) return res.status(400).json({ error: 'This survey is not active.' });
    const questionId = link.current_active_question_id;
    if (!questionId) return res.json({ survey: link, question: null, message: 'No question is active yet.' });
    const question = await getQuestionWithOptions(questionId);
    const results = await calculateQuestionResults(questionId);
    res.json({ survey: link, question, results });
  } catch (error) { next(error); }
});

app.get('/api/public/question/:token', async (req, res, next) => {
  try {
    const link = await loadPublicLink(req.params.token, 'question');
    if (!link) return res.status(404).json({ error: 'Question link is no longer active.' });
    const question = await getQuestionWithOptions(link.question_id);
    const results = await calculateQuestionResults(link.question_id);
    res.json({ survey: link, question, results });
  } catch (error) { next(error); }
});

app.get('/api/public/live/:token', async (req, res, next) => {
  try {
    const link = await loadPublicLink(req.params.token, 'live_results');
    if (!link) return res.status(404).json({ error: 'Live results link is no longer active.' });
    const qId = link.current_active_question_id;
    const question = qId ? await getQuestionWithOptions(qId) : null;
    const results = qId ? await calculateQuestionResults(qId) : null;
    res.json({ survey: link, question, results });
  } catch (error) { next(error); }
});

app.post('/api/public/:kind/:token/respond', async (req, res, next) => {
  try {
    const scope = req.params.kind === 'survey' ? 'survey' : 'question';
    const link = await loadPublicLink(req.params.token, scope);
    if (!link) return res.status(404).json({ error: 'This link is no longer active.' });
    if (link.survey_status !== 'active') return res.status(400).json({ error: 'This survey is not active.' });
    const questionId = scope === 'survey' ? link.current_active_question_id : link.question_id;
    if (!questionId) return res.status(400).json({ error: 'No active question is available.' });
    const question = await getQuestionWithOptions(questionId);
    if (!question || !['active','draft'].includes(question.status)) return res.status(400).json({ error: 'This question is not open.' });
    const fingerprint = String(req.body.fingerprint || req.ip || '').slice(0, 300);
    const respondentEmail = normalizeEmail(req.body.email || '');
    const optionIds = Array.isArray(req.body.optionIds) ? req.body.optionIds : (req.body.optionId ? [req.body.optionId] : []);
    const textAnswer = String(req.body.textAnswer || '').trim().slice(0, 1000);

    if (question.question_type === 'tag_cloud' && !textAnswer) return res.status(400).json({ error: 'Enter a short answer.' });
    if (question.question_type !== 'tag_cloud' && !optionIds.length) return res.status(400).json({ error: 'Select an option.' });
    if (question.question_type === 'single_choice' && optionIds.length > 1) return res.status(400).json({ error: 'Select only one option.' });

    await tx(async (client) => {
      if (fingerprint) {
        await client.query(`
          DELETE FROM response_answers WHERE response_id IN (SELECT id FROM responses WHERE question_id=$1 AND respondent_fingerprint=$2)
        `, [questionId, fingerprint]);
        await client.query('DELETE FROM responses WHERE question_id=$1 AND respondent_fingerprint=$2', [questionId, fingerprint]);
      }
      const r = await client.query(`
        INSERT INTO responses(survey_id, question_id, respondent_fingerprint, respondent_email, platform)
        VALUES($1,$2,$3,$4,'web') RETURNING *
      `, [question.survey_id, questionId, fingerprint || null, respondentEmail || null]);
      const response = r.rows[0];
      if (question.question_type === 'tag_cloud') {
        await client.query('INSERT INTO response_answers(response_id, question_id, text_answer) VALUES($1,$2,$3)', [response.id, questionId, textAnswer]);
      } else {
        const allowed = new Set(question.options.map((o) => o.id));
        for (const optionId of optionIds) {
          if (allowed.has(optionId)) await client.query('INSERT INTO response_answers(response_id, question_id, option_id) VALUES($1,$2,$3)', [response.id, questionId, optionId]);
        }
      }
    });
    await broadcastQuestionResults(io, questionId);
    res.json({ ok: true, results: await calculateQuestionResults(questionId) });
  } catch (error) { next(error); }
});

app.get('/api/questions/:questionId/results', requireUser, async (req, res, next) => {
  try {
    const q = await query('SELECT q.*, s.owner_user_id FROM survey_questions q JOIN surveys s ON s.id=q.survey_id WHERE q.id=$1', [req.params.questionId]);
    if (!q.rows[0]) return res.status(404).json({ error: 'Question not found.' });
    if (q.rows[0].owner_user_id !== req.user.id && req.user.role_global !== 'app_admin') return res.status(403).json({ error: 'No access.' });
    res.json({ results: await calculateQuestionResults(req.params.questionId) });
  } catch (error) { next(error); }
});

app.get('/api/surveys/:id/results', requireUser, requireSurveyOwner, async (req, res, next) => {
  try {
    const questions = await query('SELECT * FROM survey_questions WHERE survey_id=$1 ORDER BY display_order, created_at', [req.survey.id]);
    const results = {};
    for (const q of questions.rows) results[q.id] = await calculateQuestionResults(q.id);
    res.json({ survey: req.survey, questions: questions.rows, results });
  } catch (error) { next(error); }
});

app.post('/api/surveys/:id/analyze', requireUser, requireSurveyOwner, async (req, res, next) => {
  try {
    const questions = await query('SELECT * FROM survey_questions WHERE survey_id=$1 ORDER BY display_order, created_at', [req.survey.id]);
    const results = {};
    for (const q of questions.rows) results[q.id] = await calculateQuestionResults(q.id);
    const analysis = await analyzeResults({ survey: req.survey, questions: questions.rows, results });
    await query('INSERT INTO ai_runs(user_id, survey_id, run_type, input_json, output_json, model) VALUES($1,$2,$3,$4,$5,$6)', [req.user.id, req.survey.id, 'results_analysis', { survey: req.survey, questions: questions.rows, results }, analysis.parsed, analysis.provider]);
    res.json({ analysis: analysis.parsed, provider: analysis.provider });
  } catch (error) { next(error); }
});

app.get('/api/email-groups', requireUser, async (req, res, next) => {
  try {
    const groups = await query('SELECT * FROM email_groups WHERE owner_user_id=$1 ORDER BY created_at DESC', [req.user.id]);
    res.json({ groups: groups.rows });
  } catch (error) { next(error); }
});

app.post('/api/email-groups', requireUser, async (req, res, next) => {
  try {
    const group = await query('INSERT INTO email_groups(owner_user_id, name) VALUES($1,$2) RETURNING *', [req.user.id, String(req.body.name || 'New Group').trim().slice(0, 100)]);
    res.json({ group: group.rows[0] });
  } catch (error) { next(error); }
});

app.post('/api/email-groups/:groupId/members', requireUser, async (req, res, next) => {
  try {
    const group = await query('SELECT * FROM email_groups WHERE id=$1 AND owner_user_id=$2', [req.params.groupId, req.user.id]);
    if (!group.rows[0]) return res.status(404).json({ error: 'Email group not found.' });
    const members = Array.isArray(req.body.members) ? req.body.members : String(req.body.emails || '').split(/[\n,;]/).map((email) => ({ email }));
    for (const member of members) {
      const email = normalizeEmail(member.email || member);
      const name = String(member.name || '').trim().slice(0, 100);
      if (email) await query('INSERT INTO email_group_members(group_id, email, name) VALUES($1,$2,$3) ON CONFLICT(group_id,email) DO UPDATE SET name=EXCLUDED.name', [req.params.groupId, email, name || null]);
    }
    const result = await query('SELECT * FROM email_group_members WHERE group_id=$1 ORDER BY email', [req.params.groupId]);
    res.json({ members: result.rows });
  } catch (error) { next(error); }
});

app.post('/api/surveys/:id/send-email', requireUser, requireSurveyOwner, async (req, res, next) => {
  try {
    const subject = String(req.body.subject || `Please respond: ${req.survey.title}`).trim().slice(0, 200);
    const body = String(req.body.body || '').trim().slice(0, 10000);
    const groupIds = Array.isArray(req.body.groupIds) ? req.body.groupIds : [];
    const directEmails = Array.isArray(req.body.emails) ? req.body.emails : String(req.body.emails || '').split(/[\n,;]/);
    const recipients = new Set(directEmails.map(normalizeEmail).filter(Boolean));
    if (groupIds.length) {
      const members = await query(`
        SELECT egm.email FROM email_group_members egm
        JOIN email_groups eg ON eg.id=egm.group_id
        WHERE eg.owner_user_id=$1 AND eg.id = ANY($2::uuid[])
      `, [req.user.id, groupIds]);
      members.rows.forEach((m) => recipients.add(normalizeEmail(m.email)));
    }
    if (!recipients.size) return res.status(400).json({ error: 'Add at least one recipient.' });
    let share = await query(`SELECT * FROM survey_share_links WHERE survey_id=$1 AND scope='survey' AND is_active=true ORDER BY created_at DESC LIMIT 1`, [req.survey.id]);
    if (!share.rows[0]) {
      share = await query(`INSERT INTO survey_share_links(survey_id, token, version, scope) VALUES($1,$2,1,'survey') RETURNING *`, [req.survey.id, token()]);
    }
    const url = questionPublicUrl(share.rows[0]);
    const bodyWithLink = body.includes(url) ? body : `${body}\n\nOpen survey: ${url}`;
    const htmlBody = escapeHtmlServer(bodyWithLink).replace(/\n/g, '<br>');
    const html = `${htmlBody}<p><a href="${url}">Open survey</a></p>`;
    await sendMail({ fromEmail: req.user.email, to: [...recipients].join(','), subject, html, text: bodyWithLink, replyTo: req.user.email });
    const send = await query('INSERT INTO email_sends(survey_id, sent_by_user_id, subject, body, from_email, recipient_count, status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [req.survey.id, req.user.id, subject, html, req.user.email, recipients.size, 'sent']);
    res.json({ ok: true, sent: send.rows[0], recipients: recipients.size, url });
  } catch (error) { next(error); }
});

app.post('/api/billing/checkout', requireUser, async (req, res, next) => {
  try {
    const plan = ['basic','pro','enterprise'].includes(req.body.plan) ? req.body.plan : 'pro';
    if (plan === 'basic') {
      return res.json({ url: `${APP_BASE_URL}/subscription.html?basic=1`, message: 'Basic is free and already available.' });
    }
    if (!stripe) return res.status(400).json({ error: 'Stripe is not configured.' });
    const priceMap = { pro: process.env.STRIPE_PRICE_PRO, enterprise: STRIPE_PRICE_ENTERPRISE };
    const price = priceMap[plan];
    if (!price) return res.status(400).json({ error: `Stripe price is not configured for ${plan}.` });
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: req.user.email,
      line_items: [{ price, quantity: 1 }],
      success_url: `${APP_BASE_URL}/app/subscription.html?success=1`,
      cancel_url: `${APP_BASE_URL}/app/subscription.html?canceled=1`,
      metadata: { userId: req.user.id, plan },
      subscription_data: { metadata: { userId: req.user.id, plan } }
    });
    res.json({ url: session.url });
  } catch (error) { next(error); }
});

app.post('/api/billing/portal', requireUser, async (req, res, next) => {
  try {
    if (!stripe) return res.status(400).json({ error: 'Stripe is not configured.' });
    const sub = await getSubscriptionForUser(req.user.id);
    if (!sub?.stripe_customer_id) return res.status(400).json({ error: 'No Stripe customer exists for this account yet.' });
    const portal = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: process.env.STRIPE_PORTAL_RETURN_URL || `${APP_BASE_URL}/app/subscription.html`
    });
    res.json({ url: portal.url });
  } catch (error) { next(error); }
});

app.get('/api/billing/status', requireUser, async (req, res, next) => {
  try {
    const sub = await getSubscriptionForUser(req.user.id);
    const usage = await canCreateSurvey(req.user);
    res.json({ subscription: sub, usage });
  } catch (error) { next(error); }
});

app.get('/api/orgs', requireUser, async (req, res, next) => {
  try {
    const rows = await getMemberships(req.user.id, req.user.email);
    res.json({ memberships: rows });
  } catch (error) { next(error); }
});

app.post('/api/orgs', requireUser, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: 'Organization name is required.' });
    const org = await tx(async (client) => {
      const created = await client.query('INSERT INTO organizations(name, plan, max_active_users) VALUES($1,\'enterprise\',$2) RETURNING *', [name, Number(process.env.ENTERPRISE_STARTING_USER_LIMIT || 10)]);
      await client.query('INSERT INTO organization_members(organization_id, user_id, email, role, status, invited_by, joined_at) VALUES($1,$2,$3,\'owner\',\'active\',$2,now())', [created.rows[0].id, req.user.id, req.user.email]);
      return created.rows[0];
    });
    res.json({ organization: org });
  } catch (error) { next(error); }
});

async function requireOrgAdmin(req, res, next) {
  try {
    const result = await query(`
      SELECT om.*, o.max_active_users FROM organization_members om
      JOIN organizations o ON o.id=om.organization_id
      WHERE om.organization_id=$1 AND om.user_id=$2 AND om.status='active' AND om.role IN ('owner','admin')
    `, [req.params.orgId, req.user.id]);
    if (!result.rows[0] && req.user.role_global !== 'app_admin') return res.status(403).json({ error: 'Organization admin access required.' });
    req.orgMember = result.rows[0] || null;
    next();
  } catch (error) { next(error); }
}

app.get('/api/orgs/:orgId/members', requireUser, requireOrgAdmin, async (req, res, next) => {
  try {
    const members = await query('SELECT * FROM organization_members WHERE organization_id=$1 ORDER BY status, role, email', [req.params.orgId]);
    const org = await query('SELECT * FROM organizations WHERE id=$1', [req.params.orgId]);
    res.json({ organization: org.rows[0], members: members.rows });
  } catch (error) { next(error); }
});

app.post('/api/orgs/:orgId/invite', requireUser, requireOrgAdmin, async (req, res, next) => {
  try {
    const org = await query('SELECT * FROM organizations WHERE id=$1', [req.params.orgId]);
    if (!org.rows[0]) return res.status(404).json({ error: 'Organization not found.' });
    const active = await query("SELECT count(*)::int AS count FROM organization_members WHERE organization_id=$1 AND status='active'", [req.params.orgId]);
    const emails = Array.isArray(req.body.emails) ? req.body.emails : String(req.body.emails || '').split(/[\n,;]/);
    const role = ['admin','creator','viewer'].includes(req.body.role) ? req.body.role : 'creator';
    const created = [];
    for (const raw of emails) {
      if (active.rows[0].count + created.length >= org.rows[0].max_active_users) break;
      const email = normalizeEmail(raw.email || raw);
      if (!email) continue;
      const existingUser = await query('SELECT id FROM users WHERE lower(email)=lower($1)', [email]);
      const member = await query(`
        INSERT INTO organization_members(organization_id, user_id, email, role, status, invited_by)
        VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(organization_id,email) DO UPDATE SET role=EXCLUDED.role, status=EXCLUDED.status
        RETURNING *
      `, [req.params.orgId, existingUser.rows[0]?.id || null, email, role, existingUser.rows[0] ? 'active' : 'invited', req.user.id]);
      created.push(member.rows[0]);
      try {
        await sendMail({
          fromEmail: req.user.email,
          to: email,
          subject: `You're invited to Athena Survey: ${org.rows[0].name}`,
          html: `<p>${req.user.name || req.user.email} invited you to join ${org.rows[0].name} on Athena Survey.</p><p><a href="${APP_BASE_URL}/auth/google">Accept invitation</a></p>`,
          replyTo: req.user.email
        });
      } catch (mailError) { console.warn('[org:invite:email]', mailError.message); }
    }
    res.json({ invited: created });
  } catch (error) { next(error); }
});

app.patch('/api/orgs/:orgId/members/:memberId', requireUser, requireOrgAdmin, async (req, res, next) => {
  try {
    const status = ['active','inactive','invited'].includes(req.body.status) ? req.body.status : null;
    const role = ['owner','admin','creator','viewer'].includes(req.body.role) ? req.body.role : null;
    const member = await query('UPDATE organization_members SET status=COALESCE($1,status), role=COALESCE($2,role) WHERE id=$3 AND organization_id=$4 RETURNING *', [status, role, req.params.memberId, req.params.orgId]);
    res.json({ member: member.rows[0] });
  } catch (error) { next(error); }
});

app.get('/api/admin/orgs', requireAppAdmin, async (req, res, next) => {
  try {
    const orgs = await query(`
      SELECT o.*, count(om.id)::int AS member_count, count(om.id) FILTER (WHERE om.status='active')::int AS active_member_count
      FROM organizations o LEFT JOIN organization_members om ON om.organization_id=o.id
      GROUP BY o.id ORDER BY o.created_at DESC
    `);
    res.json({ organizations: orgs.rows });
  } catch (error) { next(error); }
});

app.patch('/api/admin/orgs/:orgId', requireAppAdmin, async (req, res, next) => {
  try {
    const plan = ['basic','pro','enterprise'].includes(req.body.plan) ? req.body.plan : null;
    const maxActiveUsers = Number.isFinite(Number(req.body.maxActiveUsers)) ? Number(req.body.maxActiveUsers) : null;
    const status = ['active','inactive','trial','canceled'].includes(req.body.status) ? req.body.status : null;
    const org = await query('UPDATE organizations SET plan=COALESCE($1,plan), max_active_users=COALESCE($2,max_active_users), status=COALESCE($3,status), updated_at=now() WHERE id=$4 RETURNING *', [plan, maxActiveUsers, status, req.params.orgId]);
    res.json({ organization: org.rows[0] });
  } catch (error) { next(error); }
});

app.get('/api/admin/tiers', requireAppAdmin, (req, res) => {
  res.json({
    tiers: {
      basic: { ...PLAN_LIMITS.basic, monthlyPrice: 0, stripePrice: null },
      pro: { ...PLAN_LIMITS.pro, stripePrice: process.env.STRIPE_PRICE_PRO || null, monthlyPrice: 5.99 },
      enterprise: { ...PLAN_LIMITS.enterprise, stripePrice: STRIPE_PRICE_ENTERPRISE || null, startingPrice: Number(process.env.ENTERPRISE_STARTING_PRICE || 49.99) }
    }
  });
});

// Direct routes keep marketing and app surfaces separate, without SPA catch-all confusion.
app.get('/s/:token', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'public-survey.html')));
app.get('/q/:token', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'public-question.html')));
app.get('/live/:token', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'live-results.html')));
app.get('/app', (req, res) => res.redirect('/app.html'));
app.get('/app/:page', (req, res) => res.sendFile(path.join(PUBLIC_DIR, `${req.params.page}.html`)));

app.use((error, req, res, next) => {
  console.error('[error]', error);
  if (res.headersSent) return next(error);
  res.status(error.status || 500).json({ error: error.message || 'Something went wrong.' });
});

server.listen(PORT, () => {
  console.log(`Athena Survey listening on ${PORT}`);
  console.log(`Base URL: ${APP_BASE_URL}`);
});
