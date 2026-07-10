(async()=>{
  await Athena.requireAuth();
  const id=new URLSearchParams(location.search).get('id');if(!id) location.href='/surveys.html';
  async function load(){return Athena.api(`/api/surveys/${id}`)}
  async function render(){const d=await load();Athena.appShell('surveys.html',`<div class="page-head"><div><h1>${Athena.escapeHtml(d.survey.title)}</h1><p class="muted">${Athena.escapeHtml(d.survey.description||'')}</p></div><div class="row"><span class="${Athena.statusClass(d.survey.status)}">${d.survey.status}</span><button class="btn primary" id="activate">Activate survey</button><button class="btn soft" id="inactive">Inactivate</button><button class="btn danger" id="close">Close</button></div></div><div class="grid four"><a class="card" href="/survey-questions.html?id=${id}"><span class="mini-label">Questions</span><div class="stat">${d.questions.length}</div></a><a class="card" href="/survey-share.html?id=${id}"><span class="mini-label">Share</span><div class="stat">QR</div></a><a class="card" href="/survey-responses.html?id=${id}"><span class="mini-label">Responses</span><div class="stat">Live</div></a><a class="card" href="/survey-email.html?id=${id}"><span class="mini-label">Email</span><div class="stat">Send</div></a></div><section class="section"><h2>Questions</h2><div class="list">${d.questions.map(q=>`<div class="panel survey-row"><div><strong>${Athena.escapeHtml(q.question_text)}</strong><p class="muted">${q.question_type}</p></div><div class="row"><span class="${Athena.statusClass(q.status)}">${q.status}</span><button class="btn primary qact" data-q="${q.id}">Go live</button><button class="btn soft qcomp" data-q="${q.id}">Complete</button></div></div>`).join('')||'<p>No questions yet.</p>'}</div></section>`);
    Athena.$('#activate').onclick=()=>Athena.api(`/api/surveys/${id}/activate`,{method:'POST'}).then(render).catch(e=>Athena.toast(e.message));
    Athena.$('#inactive').onclick=()=>Athena.api(`/api/surveys/${id}/inactivate`,{method:'POST'}).then(render).catch(e=>Athena.toast(e.message));
    Athena.$('#close').onclick=()=>Athena.api(`/api/surveys/${id}/close`,{method:'POST'}).then(render).catch(e=>Athena.toast(e.message));
    Athena.$all('.qact').forEach(b=>b.onclick=()=>Athena.api(`/api/questions/${b.dataset.q}/activate`,{method:'POST'}).then(render).catch(e=>Athena.toast(e.message)));
    Athena.$all('.qcomp').forEach(b=>b.onclick=()=>Athena.api(`/api/questions/${b.dataset.q}/complete`,{method:'POST'}).then(render).catch(e=>Athena.toast(e.message)));
  }
  render();
})();
