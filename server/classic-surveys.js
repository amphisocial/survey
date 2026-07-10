const path = require('path');
const QRCode = require('qrcode');

module.exports = function registerClassicSurveys(ctx) {
  const {
    app,
    PUBLIC_DIR,
    APP_BASE_URL,
    query,
    tx,
    currentUser,
    requireUser,
    requireSurveyOwner,
    normalizeEmail,
    token,
    calculateQuestionResults,
    sendMail
  } = ctx;

  function takeUrl(link) {
    return `${APP_BASE_URL}/take/${link.token}`;
  }

  function clean(value, max = 500) {
    return String(value || '').trim().slice(0, max);
  }

  async function getOrCreateClassicLink(surveyId) {
    let share = await query(
      `SELECT * FROM survey_share_links
       WHERE survey_id=$1 AND scope='classic_survey' AND is_active=true
       ORDER BY created_at DESC LIMIT 1`,
      [surveyId]
    );

    if (!share.rows[0]) {
      const version = await query(
        `SELECT COALESCE(max(version),0)+1 AS version
         FROM survey_share_links
         WHERE survey_id=$1 AND scope='classic_survey'`,
        [surveyId]
      );
      share = await query(
        `INSERT INTO survey_share_links(survey_id, token, version, scope)
         VALUES($1,$2,$3,'classic_survey')
         RETURNING *`,
        [surveyId, token(), version.rows[0].version]
      );
    }

    return share.rows[0];
  }

  async function loadClassicLink(tokenValue) {
    const result = await query(`
      SELECT
        l.*,
        s.title,
        s.description,
        s.status AS survey_status,
        s.survey_mode,
        s.report_status,
        s.respondent_identity_mode,
        s.allow_anonymous,
        s.allow_multiple_submissions,
        s.owner_user_id
      FROM survey_share_links l
      JOIN surveys s ON s.id = l.survey_id
      WHERE l.token = $1
        AND l.is_active = true
        AND l.scope = 'classic_survey'
    `, [tokenValue]);

    return result.rows[0] || null;
  }

  async function getClassicQuestions(surveyId) {
    const questions = await query(`
      SELECT *
      FROM survey_questions
      WHERE survey_id=$1
        AND status NOT IN ('inactive','closed')
      ORDER BY display_order, created_at
    `, [surveyId]);

    const ids = questions.rows.map(q => q.id);
    const options = ids.length
      ? await query(
          `SELECT * FROM question_options
           WHERE question_id = ANY($1::uuid[])
             AND is_active = true
           ORDER BY display_order, created_at`,
          [ids]
        )
      : { rows: [] };

    return {
      questions: questions.rows,
      options: options.rows
    };
  }

  function groupOptionsByQuestion(options) {
    return options.reduce((acc, option) => {
      acc[option.question_id] ||= [];
      acc[option.question_id].push(option);
      return acc;
    }, {});
  }

  app.get('/take/:token', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'classic-survey.html'));
  });

  app.get('/api/public/classic/:token', async (req, res, next) => {
    try {
      const link = await loadClassicLink(req.params.token);
      if (!link) return res.status(404).json({ error: 'Survey link is no longer active.' });
      if (link.survey_mode !== 'classic') return res.status(400).json({ error: 'This is not a classic survey.' });
      if (link.survey_status !== 'active') return res.status(400).json({ error: 'This survey is not open.' });

      const payload = await getClassicQuestions(link.survey_id);
      res.json({
        survey: link,
        questions: payload.questions,
        options: payload.options
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/public/classic/:token/submit', async (req, res, next) => {
    try {
      const link = await loadClassicLink(req.params.token);
      if (!link) return res.status(404).json({ error: 'Survey link is no longer active.' });
      if (link.survey_mode !== 'classic') return res.status(400).json({ error: 'This is not a classic survey.' });
      if (link.survey_status !== 'active') return res.status(400).json({ error: 'This survey is not open.' });

      const user = await currentUser(req);
      if (link.respondent_identity_mode === 'invite_required' && !user) {
        return res.status(401).json({ error: 'Please sign in to complete this survey.' });
      }

      const identity = req.body.identity || {};
      const requestedAnonymous = req.body.isAnonymous !== false;
      const isAnonymous = link.respondent_identity_mode === 'anonymous_only'
        ? true
        : requestedAnonymous;

      const firstName = isAnonymous ? null : clean(identity.firstName, 100);
      const lastName = isAnonymous ? null : clean(identity.lastName, 100);
      const email = isAnonymous ? null : normalizeEmail(identity.email || user?.email || '');
      const fingerprint = clean(req.body.fingerprint || req.ip || '', 300);

      if (link.respondent_identity_mode === 'identified_required' && !email) {
        return res.status(400).json({ error: 'Email is required for this survey.' });
      }

      const payload = await getClassicQuestions(link.survey_id);
      const questionById = Object.fromEntries(payload.questions.map(q => [q.id, q]));
      const optionsByQuestion = groupOptionsByQuestion(payload.options);
      const answers = Array.isArray(req.body.answers) ? req.body.answers : [];

      if (!payload.questions.length) return res.status(400).json({ error: 'This survey has no questions yet.' });

      const answerByQuestion = new Map();
      for (const answer of answers) {
        if (answer?.questionId) answerByQuestion.set(answer.questionId, answer);
      }

      for (const question of payload.questions) {
        const answer = answerByQuestion.get(question.id);
        if (!answer) return res.status(400).json({ error: `Answer required: ${question.question_text}` });

        if (question.question_type === 'tag_cloud') {
          if (!clean(answer.textAnswer, 1000)) return res.status(400).json({ error: `Answer required: ${question.question_text}` });
        } else {
          const optionIds = Array.isArray(answer.optionIds) ? answer.optionIds : (answer.optionId ? [answer.optionId] : []);
          if (!optionIds.length) return res.status(400).json({ error: `Select an option: ${question.question_text}` });
          if (question.question_type === 'single_choice' && optionIds.length > 1) {
            return res.status(400).json({ error: `Select only one option: ${question.question_text}` });
          }
        }
      }

      if (!link.allow_multiple_submissions) {
        const existing = await query(`
          SELECT id
          FROM survey_submissions
          WHERE survey_id=$1
            AND status='submitted'
            AND (
              ($2::uuid IS NOT NULL AND respondent_user_id=$2)
              OR ($3::text <> '' AND lower(email)=lower($3))
              OR ($4::text <> '' AND respondent_fingerprint=$4)
            )
          LIMIT 1
        `, [link.survey_id, user?.id || null, email || '', fingerprint || '']);

        if (existing.rows[0]) {
          return res.status(400).json({ error: 'You have already submitted this survey.' });
        }
      }

      const submission = await tx(async (client) => {
        const created = await client.query(`
          INSERT INTO survey_submissions(
            survey_id,
            share_link_id,
            respondent_user_id,
            first_name,
            last_name,
            email,
            respondent_fingerprint,
            is_anonymous,
            status,
            submitted_at,
            updated_at
          )
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'submitted',now(),now())
          RETURNING *
        `, [
          link.survey_id,
          link.id,
          user?.id || null,
          firstName,
          lastName,
          email,
          fingerprint || null,
          isAnonymous
        ]);

        const submissionRow = created.rows[0];

        for (const question of payload.questions) {
          const answer = answerByQuestion.get(question.id);
          const response = await client.query(`
            INSERT INTO responses(survey_id, question_id, respondent_fingerprint, respondent_email, platform, submission_id)
            VALUES($1,$2,$3,$4,'classic_web',$5)
            RETURNING *
          `, [link.survey_id, question.id, fingerprint || null, email || null, submissionRow.id]);

          if (question.question_type === 'tag_cloud') {
            await client.query(
              `INSERT INTO response_answers(response_id, question_id, text_answer)
               VALUES($1,$2,$3)`,
              [response.rows[0].id, question.id, clean(answer.textAnswer, 1000)]
            );
          } else {
            const allowed = new Set((optionsByQuestion[question.id] || []).map(o => o.id));
            const optionIds = Array.isArray(answer.optionIds) ? answer.optionIds : (answer.optionId ? [answer.optionId] : []);
            for (const optionId of optionIds) {
              if (allowed.has(optionId)) {
                await client.query(
                  `INSERT INTO response_answers(response_id, question_id, option_id)
                   VALUES($1,$2,$3)`,
                  [response.rows[0].id, question.id, optionId]
                );
              }
            }
          }
        }

        return submissionRow;
      });

      res.json({
        ok: true,
        submission,
        reportAvailable: link.report_status === 'published'
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/surveys/:id/classic-settings', requireUser, requireSurveyOwner, async (req, res, next) => {
    try {
      const mode = ['live','classic'].includes(req.body.surveyMode || req.body.survey_mode)
        ? (req.body.surveyMode || req.body.survey_mode)
        : req.survey.survey_mode || 'live';

      const identityMode = ['anonymous_only','anonymous_or_identified','identified_required','invite_required'].includes(req.body.respondentIdentityMode || req.body.respondent_identity_mode)
        ? (req.body.respondentIdentityMode || req.body.respondent_identity_mode)
        : req.survey.respondent_identity_mode || 'anonymous_or_identified';

      const result = await query(`
        UPDATE surveys
        SET survey_mode=$1,
            respondent_identity_mode=$2,
            show_live_results=CASE WHEN $1='classic' THEN false ELSE show_live_results END,
            updated_at=now()
        WHERE id=$3
        RETURNING *
      `, [mode, identityMode, req.survey.id]);

      res.json({ survey: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/surveys/:id/classic-share-link', requireUser, requireSurveyOwner, async (req, res, next) => {
    try {
      if ((req.survey.survey_mode || 'live') !== 'classic') {
        return res.status(400).json({ error: 'This survey is not a classic survey.' });
      }

      const link = await getOrCreateClassicLink(req.survey.id);
      const url = takeUrl(link);
      const qr = await QRCode.toDataURL(url, { margin: 1, width: 360 });

      res.json({ link, url, qr });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/surveys/:id/classic-send-email', requireUser, requireSurveyOwner, async (req, res, next) => {
    try {
      if ((req.survey.survey_mode || 'live') !== 'classic') {
        return res.status(400).json({ error: 'This survey is not a classic survey.' });
      }

      const subject = clean(req.body.subject || `Please respond: ${req.survey.title}`, 200);
      const body = clean(req.body.body || '', 10000);
      const directEmails = Array.isArray(req.body.emails) ? req.body.emails : String(req.body.emails || '').split(/[\n,;]/);
      const recipients = new Set(directEmails.map(normalizeEmail).filter(Boolean));
      const groupIds = Array.isArray(req.body.groupIds) ? req.body.groupIds : [];

      if (groupIds.length) {
        const members = await query(`
          SELECT egm.email
          FROM email_group_members egm
          JOIN email_groups eg ON eg.id=egm.group_id
          WHERE eg.owner_user_id=$1 AND eg.id = ANY($2::uuid[])
        `, [req.user.id, groupIds]);
        members.rows.forEach(m => recipients.add(normalizeEmail(m.email)));
      }

      if (!recipients.size) return res.status(400).json({ error: 'Add at least one recipient.' });

      const link = await getOrCreateClassicLink(req.survey.id);
      const url = takeUrl(link);
      const bodyWithLink = body.includes(url) ? body : `${body}\n\nOpen survey: ${url}`;
      const html = `${String(bodyWithLink)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>')}<p><a href="${url}">Open survey</a></p>`;

      await sendMail({
        fromEmail: req.user.email,
        to: [...recipients].join(','),
        subject,
        html,
        text: bodyWithLink,
        replyTo: req.user.email
      });

      const send = await query(
        `INSERT INTO email_sends(survey_id, sent_by_user_id, subject, body, from_email, recipient_count, status)
         VALUES($1,$2,$3,$4,$5,$6,'sent')
         RETURNING *`,
        [req.survey.id, req.user.id, subject, html, req.user.email, recipients.size]
      );

      res.json({ ok: true, sent: send.rows[0], recipients: recipients.size, url });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/surveys/:id/publish-report', requireUser, requireSurveyOwner, async (req, res, next) => {
    try {
      const result = await query(`
        UPDATE surveys
        SET report_status='published',
            report_published_at=now(),
            updated_at=now()
        WHERE id=$1
        RETURNING *
      `, [req.survey.id]);

      res.json({ survey: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/surveys/:id/unpublish-report', requireUser, requireSurveyOwner, async (req, res, next) => {
    try {
      const result = await query(`
        UPDATE surveys
        SET report_status='draft',
            report_published_at=NULL,
            updated_at=now()
        WHERE id=$1
        RETURNING *
      `, [req.survey.id]);

      res.json({ survey: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/respondent/surveys', requireUser, async (req, res, next) => {
    try {
      const result = await query(`
        SELECT
          s.id,
          s.title,
          s.description,
          s.status,
          s.report_status,
          s.report_published_at,
          ss.status AS submission_status,
          ss.submitted_at,
          ss.id AS submission_id,
          u.name AS requested_by_name,
          u.email AS requested_by_email
        FROM survey_submissions ss
        JOIN surveys s ON s.id = ss.survey_id
        JOIN users u ON u.id = s.owner_user_id
        WHERE ss.respondent_user_id=$1
           OR lower(ss.email)=lower($2)
           OR lower(ss.invited_email)=lower($2)
        ORDER BY COALESCE(ss.submitted_at, ss.started_at) DESC
      `, [req.user.id, req.user.email]);

      res.json({ surveys: result.rows });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/respondent/surveys/:id/report', requireUser, async (req, res, next) => {
    try {
      const survey = await query(`SELECT * FROM surveys WHERE id=$1`, [req.params.id]);
      const row = survey.rows[0];
      if (!row) return res.status(404).json({ error: 'Survey not found.' });
      if (row.report_status !== 'published') return res.status(403).json({ error: 'The report has not been published yet.' });

      const participated = await query(`
        SELECT id
        FROM survey_submissions
        WHERE survey_id=$1
          AND status='submitted'
          AND (
            respondent_user_id=$2
            OR lower(email)=lower($3)
            OR lower(invited_email)=lower($3)
          )
        LIMIT 1
      `, [req.params.id, req.user.id, req.user.email]);

      if (!participated.rows[0]) return res.status(403).json({ error: 'You can only view reports for surveys you participated in.' });

      const questions = await query(
        `SELECT * FROM survey_questions WHERE survey_id=$1 ORDER BY display_order, created_at`,
        [req.params.id]
      );

      const results = {};
      for (const q of questions.rows) {
        results[q.id] = await calculateQuestionResults(q.id);
      }

      res.json({ survey: row, questions: questions.rows, results });
    } catch (error) {
      next(error);
    }
  });
};
