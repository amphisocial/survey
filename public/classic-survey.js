(async () => {
  const token = location.pathname.split('/').filter(Boolean).pop();
  const root = document.body;
  let payload;

  function optionHtml(q, options) {
    if (q.question_type === 'tag_cloud') {
      return `<textarea class="answer-text" data-q="${q.id}" rows="4" placeholder="Type your answer..."></textarea>`;
    }

    const type = q.question_type === 'single_choice' ? 'radio' : 'checkbox';
    return (options || []).map(o => `
      <label class="choice">
        <input type="${type}" name="q-${q.id}" value="${o.id}">
        <span>${Athena.escapeHtml(o.option_text)}</span>
      </label>
    `).join('');
  }

  function renderError(message) {
    root.innerHTML = `
      <main class="public-wrap">
        <section class="public-card">
          <h1>Survey unavailable</h1>
          <p class="muted">${Athena.escapeHtml(message)}</p>
        </section>
      </main>
    `;
  }

  function renderComplete(reportAvailable) {
    root.innerHTML = `
      <main class="public-wrap">
        <section class="public-card">
          <span class="section-kicker">Submitted</span>
          <h1>Thank you</h1>
          <p class="muted">Your response has been submitted.</p>
          ${reportAvailable ? '<p class="muted">The report is already published. Sign in from your dashboard to view reports you participated in.</p>' : '<p class="muted">The report will be available after the survey owner publishes it.</p>'}
          <a class="btn primary" href="/my-surveys.html">My Surveys</a>
        </section>
      </main>
    `;
  }

  function renderSurvey() {
    const optionsByQuestion = (payload.options || []).reduce((acc, o) => {
      acc[o.question_id] ||= [];
      acc[o.question_id].push(o);
      return acc;
    }, {});

    const mode = payload.survey.respondent_identity_mode || 'anonymous_or_identified';
    const allowAnonymousChoice = mode === 'anonymous_or_identified';
    const forceAnonymous = mode === 'anonymous_only';
    const requireIdentity = mode === 'identified_required' || mode === 'invite_required';

    root.innerHTML = `
      <main class="public-wrap">
        <section class="public-card">
          <span class="section-kicker">Athena Survey</span>
          <h1>${Athena.escapeHtml(payload.survey.title)}</h1>
          <p class="muted">${Athena.escapeHtml(payload.survey.description || '')}</p>
        </section>

        <form id="surveyForm" class="public-card">
          <section class="panel">
            <h2>Your information</h2>
            ${forceAnonymous ? '<p class="muted">This survey is anonymous.</p>' : ''}
            ${allowAnonymousChoice ? `
              <label class="choice">
                <input type="checkbox" id="anonymous" checked>
                <span>Submit anonymously</span>
              </label>
            ` : ''}
            ${!forceAnonymous ? `
              <div id="identityFields" class="grid two" style="${allowAnonymousChoice ? 'display:none' : ''}">
                <label>First name<input id="firstName" ${requireIdentity ? 'required' : ''}></label>
                <label>Last name<input id="lastName" ${requireIdentity ? 'required' : ''}></label>
                <label>Email<input id="email" type="email" ${requireIdentity ? 'required' : ''}></label>
              </div>
            ` : ''}
          </section>

          ${(payload.questions || []).map((q, i) => `
            <section class="panel qblock" data-q="${q.id}" data-type="${q.question_type}">
              <span class="mini-label">Question ${i + 1}</span>
              <h2>${Athena.escapeHtml(q.question_text)}</h2>
              <div class="choices">${optionHtml(q, optionsByQuestion[q.id])}</div>
            </section>
          `).join('')}

          <button class="btn primary large" type="submit">Submit survey</button>
          <div class="error" id="err"></div>
        </form>
      </main>
    `;

    const anonymous = Athena.$('#anonymous');
    if (anonymous) {
      anonymous.onchange = () => {
        const fields = Athena.$('#identityFields');
        if (fields) fields.style.display = anonymous.checked ? 'none' : 'grid';
      };
    }

    Athena.$('#surveyForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        Athena.$('#err').textContent = '';

        const isAnonymous = forceAnonymous ? true : (anonymous ? anonymous.checked : false);
        const answers = payload.questions.map(q => {
          if (q.question_type === 'tag_cloud') {
            return {
              questionId: q.id,
              textAnswer: Athena.$(`.answer-text[data-q="${q.id}"]`)?.value || ''
            };
          }

          return {
            questionId: q.id,
            optionIds: Athena.$all(`[name="q-${q.id}"]:checked`).map(x => x.value)
          };
        });

        const result = await Athena.api(`/api/public/classic/${token}/submit`, {
          method: 'POST',
          body: JSON.stringify({
            isAnonymous,
            fingerprint: Athena.getFingerprint(),
            identity: {
              firstName: Athena.$('#firstName')?.value || '',
              lastName: Athena.$('#lastName')?.value || '',
              email: Athena.$('#email')?.value || ''
            },
            answers
          })
        });

        renderComplete(result.reportAvailable);
      } catch (err) {
        Athena.$('#err').textContent = err.message;
      }
    };
  }

  try {
    payload = await Athena.api(`/api/public/classic/${token}`);
    renderSurvey();
  } catch (err) {
    renderError(err.message);
  }
})();
