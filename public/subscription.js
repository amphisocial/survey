(async()=>{
  const {user,usage}=await Athena.requireAuth();
  await Athena.api('/api/billing/status');
  const remaining = Math.max(0, (usage.limit || 0) - (usage.used || 0));
  const usageText = usage.limit >= 999999
    ? `${usage.used || 0} surveys used this month • unlimited plan`
    : `${usage.used || 0} of ${usage.limit || 0} surveys used this month • ${remaining} remaining`;
  Athena.appShell('subscription.html',`<div class="page-head"><div><h1>Subscription</h1><p class="muted">Only creators need a membership. Participants are always free.</p></div></div><div class="grid three"><article class="price-card"><h3>Basic</h3><p class="price">$0<span>/mo</span></p><p>5 surveys per month included for free.</p><button class="btn soft" disabled>${user.plan==='basic'?'Current plan':'Included'}</button></article><article class="price-card featured"><h3>Pro</h3><p class="price">$5.99<span>/mo</span></p><p>Unlimited surveys, AI builder, live results, and analysis.</p><button class="btn primary checkout" data-plan="pro">Upgrade to Pro</button></article><article class="price-card"><h3>Enterprise</h3><p class="price">$49.99+<span>/mo</span></p><p>Starts with 10 users. Org creators can create surveys.</p><a class="btn soft" href="/contact.html">Contact us</a></article></div><section class="section"><div class="panel"><h2>Current status</h2><p><strong>Plan:</strong> ${Athena.escapeHtml(user.planLabel)} | <strong>Usage:</strong> ${Athena.escapeHtml(usageText)}</p><button class="btn soft" id="portal">Manage/cancel paid subscription in Stripe portal</button><div class="error" id="err"></div></div></section>`);
  Athena.$all('.checkout').forEach(b=>b.onclick=async()=>{try{const r=await Athena.api('/api/billing/checkout',{method:'POST',body:JSON.stringify({plan:b.dataset.plan})});location.href=r.url;}catch(e){Athena.$('#err').textContent=e.message}});
  Athena.$('#portal').onclick=async()=>{try{const r=await Athena.api('/api/billing/portal',{method:'POST'});location.href=r.url;}catch(e){Athena.$('#err').textContent=e.message}};
})();
