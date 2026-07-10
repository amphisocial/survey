(async () => {
  await Athena.requireAuth();

  const id = new URLSearchParams(location.search).get('id');

  if (!id) {
    Athena.appShell('surveys.html', `
      <div class="panel">
        <h1>Select a survey first</h1>
        <p class="muted">Email sends are tied to a specific survey.</p>
        <a class="btn primary" href="/surveys.html">Go to surveys</a>
      </div>
    `);
    return;
  }

  async function getOrCreateSurveyLink(surveyData) {
    const existing = (surveyData.links || []).find(l => l.scope === 'survey' && l.is_active);
    if (existing) return `${location.origin}/s/${existing.token}`;

    const created = await Athena.api(`/api/surveys/${id}/share-link`, {
      method: 'POST',
      body: JSON.stringify({ scope: 'survey' })
    });

    return created.url;
  }

  try {
    const surveyData = await Athena.api(`/api/surveys/${id}`);
    const surveyUrl = await getOrCreateSurveyLink(surveyData);
    const surveyTitle = surveyData.survey.title || 'this survey';

    const defaultSubject = `Please respond: ${surveyTitle}`;
    const defaultBody = `Hi,

Please take a minute to respond to this short survey:

${surveyUrl}

Thank you.`;

    Athena.appShell('survey-email.html', `
      <div class="page-head">
        <div>
          <h1>Email survey</h1>
          <p class="muted">Send the public survey link to a group. The message below already includes the survey link.</p>
        </div>
        <div class="row">
          <a class="btn soft" href="/survey-share.html?id=${id}">Share / QR</a>
          <a class="btn soft" href="/survey-detail.html?id=${id}">Back</a>
        </div>
      </div>

      <div class="grid two">
        <section class="panel">
          <h2>Send email</h2>

          <div class="notice">
            <strong>Audience link:</strong>
            <a href="${surveyUrl}" target="_blank">${surveyUrl}</a>
            <button class="btn soft small" id="copySurveyLink" type="button">Copy</button>
          </div>

          <div class="form-grid">
            <label>
              Recipients
              <textarea id="emails" rows="6" placeholder="One email per line or comma-separated"></textarea>
            </label>

            <label>
              Subject
              <input id="subject" value="${Athena.escapeHtml(defaultSubject)}">
            </label>

            <label>
              Body
              <textarea id="body" rows="10">${Athena.escapeHtml(defaultBody)}</textarea>
            </label>

            <button class="btn primary" id="send">Send</button>
            <div class="error" id="err"></div>
          </div>
        </section>

        <section class="panel">
          <h2>Email groups</h2>
          <p class="muted">Create reusable groups, then paste/import members. MVP supports direct sends plus group storage APIs.</p>
          <label>New group<input id="groupName"></label>
          <button class="btn soft" id="createGroup">Create group</button>
          <div id="groups" class="list" style="margin-top:14px"></div>
        </section>
      </div>
    `);

    Athena.$('#copySurveyLink').onclick = () => {
      navigator.clipboard?.writeText(surveyUrl);
      Athena.toast('Survey link copied.');
    };

    async function loadGroups() {
      const d = await Athena.api('/api/email-groups');
      Athena.$('#groups').innerHTML = d.groups.map(g => `
        <div class="card">
          <strong>${Athena.escapeHtml(g.name)}</strong>
          <p class="muted">Group ID: ${g.id}</p>
        </div>
      `).join('') || '<p class="muted">No groups yet.</p>';
    }

    Athena.$('#createGroup').onclick = async () => {
      try {
        await Athena.api('/api/email-groups', {
          method: 'POST',
          body: JSON.stringify({ name: Athena.$('#groupName').value })
        });
        Athena.$('#groupName').value = '';
        loadGroups();
      } catch (e) {
        Athena.toast(e.message);
      }
    };

    Athena.$('#send').onclick = async () => {
      try {
        Athena.$('#err').textContent = '';
        const r = await Athena.api(`/api/surveys/${id}/send-email`, {
          method: 'POST',
          body: JSON.stringify({
            emails: Athena.$('#emails').value,
            subject: Athena.$('#subject').value,
            body: Athena.$('#body').value
          })
        });
        Athena.toast(`Sent to ${r.recipients} recipients.`);
      } catch (e) {
        Athena.$('#err').textContent = e.message;
      }
    };

    loadGroups();
  } catch (error) {
    Athena.appShell('surveys.html', `
      <div class="panel">
        <h1>Could not load email page</h1>
        <p class="muted">${Athena.escapeHtml(error.message)}</p>
        <a class="btn primary" href="/survey-detail.html?id=${id}">Back to survey</a>
      </div>
    `);
  }
})();
