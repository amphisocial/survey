(async()=>{
  await Athena.requireAuth();
  const data=await Athena.api('/api/surveys');
  Athena.appShell('surveys.html',`
    <div class="page-head">
      <div>
        <h1>Surveys</h1>
        <p class="muted">Track live surveys and classic surveys.</p>
      </div>
      <a class="btn primary" href="/survey-new.html">New survey</a>
    </div>
    <div class="list">
      ${data.surveys.map(s=>`
        <div class="panel survey-row">
          <div>
            <strong>${Athena.escapeHtml(s.title)}</strong>
            <p class="muted">
              ${Athena.escapeHtml(s.description||'')}<br>
              ${(s.survey_mode || 'live') === 'classic' ? 'Classic survey' : 'Live survey'} • ${s.question_count||0} questions • ${s.response_count||0} responses
            </p>
          </div>
          <div class="row">
            <span class="${Athena.statusClass(s.status)}">${s.status}</span>
            ${(s.survey_mode || 'live') === 'classic' ? `<span class="${Athena.statusClass(s.report_status || 'draft')}">report ${s.report_status || 'draft'}</span>` : ''}
            <a class="btn soft" href="/survey-detail.html?id=${s.id}">Open</a>
          </div>
        </div>
      `).join('')||'<div class="panel">No surveys yet.</div>'}
    </div>
  `);
})();
