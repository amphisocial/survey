(async () => {
  await Athena.requireAuth();

  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    location.href = '/surveys.html';
    return;
  }

  async function load() {
    return Athena.api(`/api/surveys/${id}`);
  }

  function questionButtons(q, mode) {
    if (mode === 'classic') {
      return `
        <span class="${Athena.statusClass(q.status)}">${q.status}</span>
        <button class="btn soft qinactive" data-q="${q.id}">Exclude</button>
        <button class="btn soft qdraft" data-q="${q.id}">Include</button>
      `;
    }
    return `
      <span class="${Athena.statusClass(q.status)}">${q.status}</span>
      <button class="btn primary qact" data-q="${q.id}">Go live</button>
      <button class="btn soft qcomp" data-q="${q.id}">Complete</button>
    `;
  }

  async function render() {
    try {
      const d = await load();
      const mode = d.survey.survey_mode || 'live';
      const classic = mode === 'classic';

      Athena.appShell('surveys.html', `
        <div class="page-head">
          <div>
            <span class="section-kicker">${classic ? 'Classic survey' : 'Live survey'}</span>
            <h1>${Athena.escapeHtml(d.survey.title)}</h1>
            <p class="muted">${Athena.escapeHtml(d.survey.description || '')}</p>
          </div>
          <div class="row">
            <span class="${Athena.statusClass(d.survey.status)}">${d.survey.status}</span>
            ${classic ? `<span class="${Athena.statusClass(d.survey.report_status || 'draft')}">report ${d.survey.report_status || 'draft'}</span>` : ''}
            <a class="btn primary" href="/survey-share.html?id=${id}">Share / QR</a>
            <a class="btn soft" href="/survey-responses.html?id=${id}">Responses</a>
            <a class="btn soft" href="/survey-email.html?id=${id}">Email Audience</a>
          </div>
        </div>

        <div class="panel">
          <div class="row" style="justify-content:space-between;gap:14px;flex-wrap:wrap">
            <div>
              <span class="section-kicker">${classic ? 'Open classic survey' : 'Go live'}</span>
              <h2>${classic ? 'Control this classic survey' : 'Control this live survey'}</h2>
              <p class="muted">${classic ? 'Open the survey, email the link, close collection, then publish the report when ready.' : 'Activate the survey, choose the active question, then share the QR/link with your audience.'}</p>
            </div>
            <div class="row">
              <button class="btn primary" id="activate">${classic ? 'Open survey' : 'Activate survey'}</button>
              <button class="btn soft" id="inactive">Inactivate</button>
              <button class="btn danger" id="close">Close</button>
              ${classic && d.survey.report_status !== 'published' ? '<button class="btn primary" id="publishReport">Publish Report</button>' : ''}
              ${classic && d.survey.report_status === 'published' ? '<button class="btn soft" id="unpublishReport">Unpublish Report</button>' : ''}
            </div>
          </div>
        </div>

        <div class="grid four">
          <a class="card" href="/survey-questions.html?id=${id}">
            <span class="mini-label">Questions</span>
            <div class="stat">${d.questions.length}</div>
          </a>
          <a class="card" href="/survey-share.html?id=${id}">
            <span class="mini-label">Share with audience</span>
            <div class="stat">QR</div>
            <p class="muted">${classic ? 'Generate classic survey link and QR.' : 'Generate survey link, question link, and live-results link.'}</p>
          </a>
          <a class="card" href="/survey-responses.html?id=${id}">
            <span class="mini-label">Responses</span>
            <div class="stat">${classic ? 'Report' : 'Live'}</div>
            <p class="muted">View charts, tag clouds, export PDF, and AI analysis.</p>
          </a>
          <a class="card" href="/survey-email.html?id=${id}">
            <span class="mini-label">Email</span>
            <div class="stat">Send</div>
            <p class="muted">Invite a group using SMTP.</p>
          </a>
        </div>

        <section class="section">
          <h2>Questions</h2>
          <div class="list">
            ${
              d.questions.map(q => `
                <div class="panel survey-row">
                  <div>
                    <strong>${Athena.escapeHtml(q.question_text)}</strong>
                    <p class="muted">${q.question_type}</p>
                  </div>
                  <div class="row">
                    ${questionButtons(q, mode)}
                  </div>
                </div>
              `).join('') || '<p>No questions yet.</p>'
            }
          </div>
        </section>
      `);

      Athena.$('#activate').onclick = () => Athena.api(`/api/surveys/${id}/activate`, { method: 'POST' }).then(render).catch(e => Athena.toast(e.message));
      Athena.$('#inactive').onclick = () => Athena.api(`/api/surveys/${id}/inactivate`, { method: 'POST' }).then(render).catch(e => Athena.toast(e.message));
      Athena.$('#close').onclick = () => Athena.api(`/api/surveys/${id}/close`, { method: 'POST' }).then(render).catch(e => Athena.toast(e.message));

      Athena.$('#publishReport')?.addEventListener('click', () => Athena.api(`/api/surveys/${id}/publish-report`, { method: 'POST' }).then(render).catch(e => Athena.toast(e.message)));
      Athena.$('#unpublishReport')?.addEventListener('click', () => Athena.api(`/api/surveys/${id}/unpublish-report`, { method: 'POST' }).then(render).catch(e => Athena.toast(e.message)));

      Athena.$all('.qact').forEach(b => {
        b.onclick = () => Athena.api(`/api/questions/${b.dataset.q}/activate`, { method: 'POST' }).then(render).catch(e => Athena.toast(e.message));
      });

      Athena.$all('.qcomp').forEach(b => {
        b.onclick = () => Athena.api(`/api/questions/${b.dataset.q}/complete`, { method: 'POST' }).then(render).catch(e => Athena.toast(e.message));
      });

      Athena.$all('.qinactive').forEach(b => {
        b.onclick = () => Athena.api(`/api/questions/${b.dataset.q}/inactivate`, { method: 'POST' }).then(render).catch(e => Athena.toast(e.message));
      });

      Athena.$all('.qdraft').forEach(b => {
        b.onclick = () => Athena.api(`/api/questions/${b.dataset.q}/complete`, { method: 'POST' }).then(render).catch(e => Athena.toast(e.message));
      });
    } catch (error) {
      Athena.appShell('surveys.html', `
        <div class="panel">
          <h1>Could not load survey</h1>
          <p class="muted">${Athena.escapeHtml(error.message)}</p>
          <a class="btn primary" href="/surveys.html">Back to surveys</a>
        </div>
      `);
    }
  }

  render();
})();
