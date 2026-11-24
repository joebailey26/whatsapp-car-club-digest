/**
 * Minimal admin page. Deliberately plain: Phase 1 only needs pairing and the
 * restore test. All dynamic values are written with textContent (no innerHTML).
 */
export const ADMIN_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Digest Admin</title>
<style>
  :root { color-scheme: light dark; --fg:#1d1d1f; --bg:#fafafa; --muted:#6b6b70; --line:#d9d9de; --accent:#0a6c5a; --bad:#b3261e; --ok:#1e7d32; }
  @media (prefers-color-scheme: dark) { :root { --fg:#ececef; --bg:#151517; --muted:#9a9aa2; --line:#333338; --accent:#4fc3a8; --bad:#ff8a80; --ok:#81c784; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px; font:15px/1.5 system-ui, sans-serif; color:var(--fg); background:var(--bg); }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; color: var(--muted); }
  section { border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
  h2 { font-size: 15px; margin: 0 0 10px; }
  .row { display:flex; flex-wrap:wrap; gap:8px; }
  button { font:inherit; padding:8px 14px; border-radius:8px; border:1px solid var(--line); background:transparent; color:var(--fg); cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.danger { color:var(--bad); }
  button:disabled { opacity:.5; cursor:default; }
  dl { display:grid; grid-template-columns: max-content 1fr; gap:4px 16px; margin:0; }
  dt { color:var(--muted); }
  dd { margin:0; overflow-wrap:anywhere; }
  .bad { color:var(--bad); } .ok { color:var(--ok); }
  #qr { display:none; margin-top:12px; }
  #qr img { max-width:100%; border:1px solid var(--line); border-radius:8px; background:#fff; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:4px 6px; border-bottom:1px solid var(--line); }
  #msg { min-height: 1.5em; margin-top: 10px; color: var(--muted); }
</style>
</head>
<body>
<main>
  <h1>WhatsApp Digest: Phase 1</h1>
  <p class="sub">Authentication persistence test. Protected by Cloudflare Access.</p>

  <section>
    <h2>Status</h2>
    <dl id="status"></dl>
    <div id="msg" role="status"></div>
  </section>

  <section>
    <h2>1. Pair WhatsApp</h2>
    <div class="row">
      <button id="pairStart" class="primary">Start pairing</button>
      <button id="pairDone">I've scanned it: complete pairing</button>
    </div>
    <p class="sub" style="margin-top:10px">On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan the code below.</p>
    <div id="qr"><img id="qrImg" alt="WhatsApp Web pairing screen"></div>
  </section>

  <section>
    <h2>2. Restore test</h2>
    <div class="row">
      <button id="restore" class="primary">Run restore test</button>
      <button id="abort" class="danger">Abort / stop container</button>
    </div>
    <p class="sub" style="margin-top:10px">Starts a new container from the snapshot and checks WhatsApp opens without a QR code. The gate needs at least two passes in a row.</p>
    <table><thead><tr><th>When</th><th>Outcome</th><th>State</th><th>Gen</th><th>Stopped</th><th>Duration</th></tr></thead><tbody id="tests"></tbody></table>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
let qrUrl = null;

async function post(path) {
  const res = await fetch(path, { method: 'POST', headers: { 'x-requested-with': 'digest-admin' } });
  const body = await res.json().catch(() => ({}));
  $('msg').textContent = res.ok ? 'Queued: ' + path.split('/').slice(-2).join(' ') : 'Refused: ' + (body.error || res.status);
  refresh();
}

function fmt(iso) { return iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London' }) : '—'; }

function row(dl, k, v, cls) {
  const dt = document.createElement('dt'); dt.textContent = k;
  const dd = document.createElement('dd'); dd.textContent = v; if (cls) dd.className = cls;
  dl.append(dt, dd);
}

async function refresh() {
  const res = await fetch('/admin/api/status', { cache: 'no-store' });
  if (!res.ok) { $('msg').textContent = 'Status failed: ' + res.status; return; }
  const s = await res.json();
  const dl = $('status'); dl.replaceChildren();
  row(dl, 'Phase', s.phase + (s.runningOp ? ' (running ' + s.runningOp + ')' : s.pendingOp ? ' (queued ' + s.pendingOp + ')' : ''));
  row(dl, 'Session', s.session, s.session === 'paired' ? 'ok' : s.session === 'relink_required' ? 'bad' : '');
  row(dl, 'Container', s.containerRunning ? 'running' : 'stopped');
  row(dl, 'Last probe', s.lastProbe ? s.lastProbe.state + ' [' + s.lastProbe.matched.join(', ') + ']' : '—');
  row(dl, 'Last error', s.lastError ? s.lastError.code + (s.lastError.detail ? ' (' + s.lastError.detail + ')' : '') + ' at ' + fmt(s.lastError.at) : '—', s.lastError ? 'bad' : '');
  row(dl, 'Snapshot', s.snapshot ? 'gen ' + s.snapshot.generation + ', ' + (s.snapshot.sizeBytes / 1048576).toFixed(1) + ' MB, image ' + s.snapshot.imageVersion + ', expires ' + fmt(s.snapshot.expiresAt) + (s.snapshot.usable ? '' : ' — UNUSABLE: ' + s.snapshot.unusableReason) : 'none', s.snapshot && !s.snapshot.usable ? 'bad' : '');
  row(dl, 'Image version', s.expectedImageVersion);
  row(dl, 'Consecutive passes', String(s.consecutivePasses), s.consecutivePasses >= 2 ? 'ok' : '');
  if (s.pairingExpiresAt) row(dl, 'Pairing expires', fmt(s.pairingExpiresAt));

  const busy = !!(s.runningOp || s.pendingOp);
  $('pairStart').disabled = busy || !(s.phase === 'idle' || s.phase === 'pairing_awaiting_scan');
  $('pairDone').disabled = busy || s.phase !== 'pairing_awaiting_scan';
  $('restore').disabled = busy || s.phase !== 'idle' || !s.snapshot;

  const tb = $('tests'); tb.replaceChildren();
  for (const t of s.restoreTests) {
    const tr = document.createElement('tr');
    for (const [v, cls] of [[fmt(t.at)], [t.outcome + (t.errorCode ? ' / ' + t.errorCode : ''), t.outcome === 'pass' ? 'ok' : 'bad'], [t.probe ? t.probe.state : '—'], [(t.generationBefore ?? '—') + '→' + (t.generationAfter ?? '—')], [t.containerStopped ? 'yes' : 'NO', t.containerStopped ? '' : 'bad'], [(t.durationMs / 1000).toFixed(0) + 's']]) {
      const td = document.createElement('td'); td.textContent = v; if (cls) td.className = cls; tr.append(td);
    }
    tb.append(tr);
  }

  const showQr = s.phase === 'pairing_awaiting_scan' && s.containerRunning;
  $('qr').style.display = showQr ? 'block' : 'none';
  if (showQr) loadQr(); else if (qrUrl) { URL.revokeObjectURL(qrUrl); qrUrl = null; $('qrImg').removeAttribute('src'); }
}

async function loadQr() {
  const res = await fetch('/admin/api/pairing/screen', { cache: 'no-store' });
  if (!res.ok) return;
  const blob = await res.blob();
  if (qrUrl) URL.revokeObjectURL(qrUrl);
  qrUrl = URL.createObjectURL(blob);
  $('qrImg').src = qrUrl;
}

$('pairStart').onclick = () => post('/admin/api/pairing/start');
$('pairDone').onclick = () => post('/admin/api/pairing/complete');
$('restore').onclick = () => post('/admin/api/test/restore');
$('abort').onclick = () => { if (confirm('Stop the container now?')) post('/admin/api/abort'); };

refresh();
setInterval(refresh, 4000);
</script>
</body>
</html>`;
