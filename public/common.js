const Athena = (() => {
  async function api(path, options = {}) {
    const headers = options.headers || {};
    if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { credentials: 'include', ...options, headers });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed');
    return data;
  }
  function $(sel, root = document) { return root.querySelector(sel); }
  function $all(sel, root = document) { return [...root.querySelectorAll(sel)]; }
  function toast(message) {
    const el = $('#toast') || Object.assign(document.body.appendChild(document.createElement('div')), { id: 'toast', className: 'toast' });
    el.textContent = message;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2800);
  }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
  }
  function statusClass(status){ return `status ${status || ''}`; }
  async function me() {
    try { return await api('/api/me'); } catch { return { user: null }; }
  }
  async function requireAuth() {
    const state = await me();
    if (!state.user) location.href = '/?login=1';
    return state;
  }
  function authArea(user) {
    const el = $('#authArea');
    if (!el) return;
    if (!user) {
      el.innerHTML = `<a class="btn soft" href="/auth/google">Sign in with Google</a>`;
    } else {
      el.innerHTML = `<a class="btn soft" href="/app.html">Dashboard</a><button class="btn" id="logoutBtn">Log out</button>`;
      $('#logoutBtn')?.addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; });
    }
  }
  function nav(active) {
    const links = [
      ['app.html','Dashboard'],['surveys.html','Surveys'],['survey-new.html','Create'],['my-surveys.html','My Surveys'],['subscription.html','Subscription'],['org-admin.html','Enterprise'],['app-admin.html','App Admin']
    ];
    return `<aside class="sidebar"><a class="brand" href="/app.html"><span class="brand-mark">A</span><span><strong>Athena</strong> Survey</span></a><div style="height:18px"></div>${links.map(([href,label]) => `<a class="${active===href?'active':''}" href="/${href}">${label}</a>`).join('')}</aside>`;
  }
  function appShell(active, inner) {
    document.body.innerHTML = `<div class="app-layout">${nav(active)}<main class="main">${inner}</main></div><div class="toast" id="toast"></div>`;
  }
  function getFingerprint() {
    const key = 'athena_survey_fp';
    let fp = localStorage.getItem(key);
    if (!fp) { fp = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`; localStorage.setItem(key, fp); }
    return fp;
  }
  function tagTone(index) {
    const tones = ['tone-indigo', 'tone-violet', 'tone-blue', 'tone-emerald', 'tone-rose', 'tone-amber', 'tone-slate'];
    return tones[index % tones.length];
  }

  function tagWeightClass(weight) {
    if (weight >= 0.82) return 'weight-xl';
    if (weight >= 0.62) return 'weight-lg';
    if (weight >= 0.42) return 'weight-md';
    if (weight >= 0.22) return 'weight-sm';
    return 'weight-xs';
  }

  function renderTagCloud(tags) {
    if (!tags?.length) return '<p class="muted">No tag responses yet.</p>';

    const sorted = [...tags]
      .filter(t => String(t.text || '').trim())
      .sort((a, b) => b.count - a.count)
      .slice(0, 40);

    const max = Math.max(...sorted.map(t => Number(t.count) || 0), 1);
    const min = Math.min(...sorted.map(t => Number(t.count) || 0), max);
    const spread = Math.max(max - min, 1);

    return `<div class="tag-cloud proper" aria-label="Live tag cloud">${
      sorted.map((t, i) => {
        const count = Number(t.count) || 0;
        const weight = (count - min) / spread;
        const size = Math.round(15 + weight * 33);
        const rotation = [-4, 2, -2, 4, 0, -1, 3][i % 7];
        const cls = `${tagTone(i)} ${tagWeightClass(weight)}`;
        return `<span class="cloud-tag ${cls}" title="${escapeHtml(t.text)} — ${count} response${count === 1 ? '' : 's'}" style="--tag-size:${size}px;--tag-rotate:${rotation}deg">${escapeHtml(t.text)}</span>`;
      }).join('')
    }</div>`;
  }

  function renderResults(results) {
    if (!results) return '<p class="muted">No results yet.</p>';
    if (results.tags) return renderTagCloud(results.tags);
    if (!results.options?.length) return '<p class="muted">No options yet.</p>';
    const total = Math.max(results.totalSelections || 0, 1);
    return results.options.map(o => `<div class="result-row"><div><strong>${escapeHtml(o.option_text)}</strong><div class="chart-bar"><span style="width:${Math.max(0, Math.round((o.count/total)*100))}%"></span></div></div><div><strong>${o.count}</strong> <span class="muted">${o.pct}%</span></div></div>`).join('');
  }
  return { api, $, $all, toast, escapeHtml, statusClass, me, requireAuth, authArea, appShell, nav, getFingerprint, renderResults };
})();
