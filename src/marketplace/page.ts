import type { StoredMarketListing } from './ingest';
import { escapeHtml, londonStamp, unknowns } from './notify';

/**
 * Admin and review pages. Dynamic values go in with textContent (admin page)
 * or are escaped server-side (review page). The pages only read on load;
 * every change is a fetch POST/PUT with the CSRF header.
 */

const STYLE = `
  :root { color-scheme: light dark; --fg:#1d1d1f; --bg:#fafafa; --muted:#6b6b70; --line:#d9d9de; --accent:#0a6c5a; --bad:#b3261e; }
  @media (prefers-color-scheme: dark) { :root { --fg:#ececef; --bg:#151517; --muted:#9a9aa2; --line:#333338; --accent:#4fc3a8; --bad:#ff8a80; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px; font:15px/1.5 system-ui, sans-serif; color:var(--fg); background:var(--bg); }
  main { max-width: 980px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 0 0 10px; }
  p.sub { margin: 0 0 20px; color: var(--muted); }
  section { border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; overflow-x:auto; }
  .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:8px; }
  button, select, input { font:inherit; padding:7px 12px; border-radius:8px; border:1px solid var(--line); background:transparent; color:var(--fg); }
  button { cursor:pointer; } button.primary { background:var(--accent); border-color:var(--accent); color:#fff; } button.danger { color:var(--bad); }
  pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; margin:0; max-height:360px; overflow:auto; }
  table { border-collapse:collapse; width:100%; font-size:13px; } td, th { border-bottom:1px solid var(--line); padding:6px; text-align:left; vertical-align:top; }
  img#screen { max-width:100%; border:1px solid var(--line); cursor:crosshair; display:none; }
  .muted { color:var(--muted); } a { color:var(--accent); }
`;

export const MARKET_ADMIN_PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Car Leads Admin</title><style>${STYLE}</style></head>
<body><main>
<h1>Marketplace car leads</h1>
<p class="sub">Hourly Facebook Marketplace collector. "First seen" is when the collector found an advert, not when it was posted.</p>

<section><h2>Status</h2>
<div class="row"><button id="refresh">Refresh</button><button id="abort" class="danger">Stop container</button></div>
<pre id="status">Loading…</pre></section>

<section><h2>Facebook sign-in (your own account, interactive)</h2>
<p class="muted">Start login opens Facebook's login page in the collector's private browser. Click on the screenshot to click there; type into the box below to type. Nothing you type is stored or logged. Solve any security check yourself; the collector never does.</p>
<div class="row"><button id="loginStart" class="primary">Start login</button><button id="loginDone">Complete login</button><button id="restore">Run restore test</button></div>
<div class="row"><input id="typeText" type="password" autocomplete="off" placeholder="text to type (sent once, then cleared)" size="34"><button id="typeBtn">Type</button>
<button data-key="Enter">Enter</button><button data-key="Tab">Tab</button><button data-key="Backspace">Backspace</button><button data-key="Escape">Esc</button></div>
<img id="screen" alt="Login screen" width="1280" height="900"></section>

<section><h2>Collect</h2>
<div class="row"><button id="dry" class="primary">Dry run (measure, no emails, no writes)</button><button id="collect">Collect now</button><button id="roundupDry">Roundup preview</button></div>
<div class="row"><label><input type="checkbox" id="ack"> I accept that automated Facebook access may breach Meta's terms and risk my account</label>
<button id="schedOn">Enable hourly schedule</button><button id="schedOff" class="danger">Pause schedule</button></div>
<pre id="out"></pre></section>

<section><h2>Listings</h2>
<div class="row"><select id="view"><option>new</option><option>alerted</option><option>review</option><option>interested</option><option>dismissed</option><option>all</option></select><button id="load">Load</button></div>
<table><thead><tr><th>Price</th><th>Title / location</th><th>Route · score</th><th>First seen</th><th></th></tr></thead><tbody id="rows"></tbody></table></section>
</main>
<script>
const H = { 'x-requested-with': 'market-admin', 'content-type': 'application/json' };
const $ = (id) => document.getElementById(id);
const out = (v) => { $('out').textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2); };
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: method === 'GET' ? {} : H, body: body === undefined ? undefined : JSON.stringify(body) });
  return r.headers.get('content-type')?.includes('json') ? r.json() : r;
}
let shotTimer = null;
async function status() {
  const s = await api('GET', '/admin/api/status');
  $('status').textContent = JSON.stringify(s, null, 2);
  const logging = s.phase === 'login_awaiting';
  $('screen').style.display = logging ? 'block' : 'none';
  if (logging && !shotTimer) shotTimer = setInterval(shot, 2500);
  if (!logging && shotTimer) { clearInterval(shotTimer); shotTimer = null; }
}
async function shot() {
  const r = await fetch('/admin/api/login/screen');
  if (!r.ok) return;
  const url = URL.createObjectURL(await r.blob());
  const img = $('screen'); const old = img.src; img.src = url; if (old.startsWith('blob:')) URL.revokeObjectURL(old);
}
$('screen').addEventListener('click', async (e) => {
  const rect = e.target.getBoundingClientRect();
  const x = Math.round((e.clientX - rect.left) * 1280 / rect.width), y = Math.round((e.clientY - rect.top) * 900 / rect.height);
  await api('POST', '/admin/api/login/input', { type: 'click', x, y }); setTimeout(shot, 600);
});
$('typeBtn').onclick = async () => { const t = $('typeText').value; $('typeText').value = ''; if (t) await api('POST', '/admin/api/login/input', { type: 'type', text: t }); setTimeout(shot, 600); };
document.querySelectorAll('[data-key]').forEach((b) => b.onclick = async () => { await api('POST', '/admin/api/login/input', { type: 'key', key: b.dataset.key }); setTimeout(shot, 600); });
$('refresh').onclick = status;
$('abort').onclick = async () => { out(await api('POST', '/admin/api/abort')); status(); };
$('loginStart').onclick = async () => { out(await api('POST', '/admin/api/login/start')); setTimeout(status, 4000); };
$('loginDone').onclick = async () => { out(await api('POST', '/admin/api/login/complete')); setTimeout(status, 4000); };
$('restore').onclick = async () => { out(await api('POST', '/admin/api/test/restore')); };
$('dry').onclick = async () => out(await api('POST', '/admin/api/collect', { dryRun: true }));
$('collect').onclick = async () => out(await api('POST', '/admin/api/collect', {}));
$('roundupDry').onclick = async () => out(await api('POST', '/admin/api/roundup', { dryRun: true }));
$('schedOn').onclick = async () => out(await api('PUT', '/admin/api/schedule', { enabled: true, acknowledgeRisk: $('ack').checked }));
$('schedOff').onclick = async () => out(await api('PUT', '/admin/api/schedule', { enabled: false }));
const gbp = (p) => p === null ? '?' : '£' + (p / 100).toLocaleString('en-GB');
$('load').onclick = async () => {
  const r = await api('GET', '/admin/api/listings?view=' + encodeURIComponent($('view').value) + '&limit=100');
  const tb = $('rows'); tb.replaceChildren();
  for (const l of r.listings || []) {
    const tr = document.createElement('tr');
    const td = (t) => { const c = document.createElement('td'); c.textContent = t; tr.appendChild(c); return c; };
    td(gbp(l.pricePence));
    const t = td(''); const a = document.createElement('a'); a.href = l.url; a.rel = 'noreferrer'; a.target = '_blank'; a.textContent = l.title; t.appendChild(a);
    t.appendChild(document.createTextNode(' · ' + (l.location || 'location unknown')));
    const why = document.createElement('div'); why.className = 'muted'; why.textContent = (l.reasons || []).join('; '); t.appendChild(why);
    td((l.route || '?') + ' · ' + (l.score ?? '?') + (l.baseline ? ' (baseline)' : '') + ' · ' + l.reviewState);
    td(new Date(l.firstSeenAt).toLocaleString('en-GB'));
    const act = td('');
    for (const [label, action] of [['Interested', 'interested'], ['Pass', 'pass'], ['Ignore', 'ignore'], ['Send alert', 'send_alert']]) {
      const b = document.createElement('button'); b.textContent = label;
      b.onclick = async () => out(await api('POST', '/admin/api/listings/' + encodeURIComponent(l.id) + '/feedback', { action }));
      act.appendChild(b);
    }
    tb.appendChild(tr);
  }
};
status();
</script></body></html>`;

/** Review page linked from emails. GET only displays; the buttons POST with the CSRF header. */
export function reviewPage(l: StoredMarketListing): string {
  const e = escapeHtml;
  const price = l.pricePence === null ? 'price not shown' : `£${(l.pricePence / 100).toLocaleString('en-GB')}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Review lead</title><style>${STYLE}</style></head>
<body><main data-id="${e(l.id)}">
<h1>${e(price)} · ${e(l.title)}</h1>
<p class="sub">${e(l.location ?? 'location unknown')} · <a href="${e(l.url)}" rel="noreferrer">open advert</a></p>
<section><h2>Why it matched (score ${e(String(l.score ?? '?'))}, ${e(l.rulesetVersion ?? '?')})</h2>
<ul>${l.reasons.map((r) => `<li>${e(r)}</li>`).join('')}</ul>
<p>First discovered: ${e(londonStamp(l.firstSeenAt))} (UK) · Originally posted: ${e(l.publishedText ?? 'not shown')}</p>
<p class="muted">Unknown: ${e(unknowns(l).join(', ') || 'nothing')} · Current state: ${e(l.reviewState)}</p></section>
<section><h2>Your verdict</h2>
<div class="row"><input id="reason" placeholder="optional reason" size="40"></div>
<div class="row"><button class="primary" data-a="interested">Interested</button><button data-a="pass">Pass</button><button data-a="ignore">Ignore</button></div>
<p id="msg" class="muted">Nothing is recorded until you press a button.</p></section>
</main>
<script>
const id = document.querySelector('main').dataset.id;
document.querySelectorAll('[data-a]').forEach((b) => b.onclick = async () => {
  const r = await fetch('/admin/api/listings/' + encodeURIComponent(id) + '/feedback', {
    method: 'POST', headers: { 'x-requested-with': 'market-admin', 'content-type': 'application/json' },
    body: JSON.stringify({ action: b.dataset.a, reason: document.getElementById('reason').value || null }),
  });
  document.getElementById('msg').textContent = r.ok ? 'Saved: ' + b.dataset.a : 'Failed (' + r.status + ')';
});
</script></body></html>`;
}
