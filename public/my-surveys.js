(async () => {
  await Athena.requireAuth();

  async function renderReport(id) {
    try {
      const d = await Athena.api(`/api/respondent/surveys/${id}/report`);
      Athena.appShell('my-surveys.html', `
        <div class="page-head">
          <div>
            <h1>${Athena.escapeHtml(d.survey.title)}</h1>
            <p class="muted">Published report</p>
          </div>
          <button class="btn soft" id="back">Back</button>
        </div>
        <div class="list">
          ${d.questions.map(q => `
            <section class="panel">
              <span class="mini-label">${q.question_type}</span>
              <h2>${Athena.escapeHtml(q.question_text)}</h2>
              <div class="results">${Athena.renderResults(d.results[q.id])}</div>
            </section>
          `).join('')}
        </div>
      `);
      Athena.$('#back').onclick = renderList;
    } catch (err) {
      Athena.toast(err.message);
    }
  }

  async function renderList() {
    const d = await Athena.api('/api/respondent/surveys');
    Athena.appShell('my-surveys.html', `
      <div class="page-head">
        <div>
          <h1>My Surveys</h1>
          <p class="muted">Surveys you completed or were asked to complete.</p>
        </div>
      </div>

      <div class="list">
        ${d.surveys.map(s => `
          <div class="panel survey-row">
            <div>
              <strong>${Athena.escapeHtml(s.title)}</strong>
              <p class="muted">
                Requested by ${Athena.escapeHtml(s.requested_by_name || s.requested_by_email || 'survey owner')}<br>
                Submitted ${s.submitted_at ? new Date(s.submitted_at).toLocaleString() : 'not yet'} • Report ${s.report_status}
              </p>
            </div>
            <div class="row">
              <span class="${Athena.statusClass(s.submission_status || 'submitted')}">${s.submission_status || 'submitted'}</span>
              ${s.report_status === 'published'
                ? `<button class="btn primary view-report" data-id="${s.id}">View Report</button>`
                : `<span class="muted">Report not published</span>`}
            </div>
          </div>
        `).join('') || '<div class="panel">No respondent surveys yet.</div>'}
      </div>
    `);

    Athena.$all('.view-report').forEach(btn => {
      btn.onclick = () => renderReport(btn.dataset.id);
    });
  }

  renderList();
})();
