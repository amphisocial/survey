(async () => {
  await Athena.requireAuth();

  const id = new URLSearchParams(location.search).get('id');
  let socket;

  if (!id) {
    Athena.appShell('surveys.html', `
      <div class="panel">
        <h1>Select a survey first</h1>
        <p class="muted">Responses are tied to a specific survey. Open a survey, then choose Responses.</p>
        <a class="btn primary" href="/surveys.html">Go to surveys</a>
      </div>
    `);
    return;
  }

  async function render() {
    try {
      const d = await Athena.api(`/api/surveys/${id}/results`);

      Athena.appShell('surveys.html', `
        <div class="page-head">
          <div>
            <h1>Responses</h1>
            <p class="muted">${Athena.escapeHtml(d.survey.title || '')} • Live results and AI analysis.</p>
          </div>
          <div class="row">
            <a class="btn primary" href="/api/surveys/${id}/export.pdf" target="_blank">Export PDF</a>
            ${(d.survey.survey_mode || 'live') === 'classic' && d.survey.report_status !== 'published' ? '<button class="btn primary" id="publishReport">Publish Report</button>' : ''}
            ${(d.survey.survey_mode || 'live') === 'classic' && d.survey.report_status === 'published' ? '<button class="btn soft" id="unpublishReport">Unpublish Report</button>' : ''}
            <button class="btn soft" id="analyze">Analyze with AI</button>
            <a class="btn soft" href="/survey-share.html?id=${id}">Share / QR</a>
            <a class="btn soft" href="/survey-detail.html?id=${id}">Back</a>
          </div>
        </div>

        <div id="analysis"></div>

        <div class="list">
          ${
            d.questions.map(q => `
              <section class="panel" id="q-${q.id}">
                <span class="mini-label">${q.question_type}</span>
                <h2>${Athena.escapeHtml(q.question_text)}</h2>
                <div class="results">${Athena.renderResults(d.results[q.id])}</div>
              </section>
            `).join('') || '<div class="panel"><p>No questions yet.</p></div>'
          }
        </div>
      `);

      Athena.$('#publishReport')?.addEventListener('click', () => Athena.api(`/api/surveys/${id}/publish-report`, { method: 'POST' }).then(render).catch(e => Athena.toast(e.message)));
      Athena.$('#unpublishReport')?.addEventListener('click', () => Athena.api(`/api/surveys/${id}/unpublish-report`, { method: 'POST' }).then(render).catch(e => Athena.toast(e.message)));

      Athena.$('#analyze').onclick = async () => {
        try {
          Athena.$('#analysis').innerHTML = '<div class="panel">Analyzing...</div>';
          const r = await Athena.api(`/api/surveys/${id}/analyze`, { method: 'POST' });
          Athena.$('#analysis').innerHTML = `
            <div class="panel">
              <span class="section-kicker">AI analysis</span>
              <h2>Executive summary</h2>
              <p>${Athena.escapeHtml(r.analysis.executiveSummary || '')}</p>
              <h3>Highlights</h3>
              <ul>${(r.analysis.highlights || []).map(x => `<li>${Athena.escapeHtml(x)}</li>`).join('')}</ul>
              <h3>Follow-up ideas</h3>
              <ul>${(r.analysis.suggestedFollowUps || []).map(x => `<li>${Athena.escapeHtml(x.question || x)}</li>`).join('')}</ul>
            </div>
          `;
        } catch (e) {
          Athena.toast(e.message);
        }
      };

      if (!socket) {
        socket = io();
        socket.emit('join:survey', id);
        socket.on('results:updated', r => {
          const el = Athena.$(`#q-${r.question.id} .results`);
          if (el) el.innerHTML = Athena.renderResults(r);
        });
      }
    } catch (error) {
      Athena.appShell('surveys.html', `
        <div class="panel">
          <h1>Could not load responses</h1>
          <p class="muted">${Athena.escapeHtml(error.message)}</p>
          <a class="btn primary" href="/surveys.html">Back to surveys</a>
        </div>
      `);
    }
  }

  render();
})();
