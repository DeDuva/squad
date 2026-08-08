/**
 * The page, as one string.
 *
 * No build step and no framework, deliberately. duva-bench has no bundler
 * today, and adding Vite plus React to a package whose entire purpose is to be
 * liftable into a standalone repo would buy three views at the cost of a build
 * pipeline to maintain and extract. squad-lab's SPA stays where it is; this
 * mounts alongside it, as the plan permits.
 *
 * Everything the page shows comes from this server's own literal routes. It
 * never holds an ADP token, never constructs an ADP URL, and never learns the
 * owner or repo except as text to display.
 */

export const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>duva-bench</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --dim:#666; --line:#ddd; --bad:#b00020;
          --ok:#0a6; --warn:#b26a00; --bg:#fff; --panel:#fafafa; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e8; --dim:#999; --line:#333; --bg:#111; --panel:#191919; } }
  * { box-sizing:border-box; }
  body { font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
         margin:0; color:var(--fg); background:var(--bg); }
  header { display:flex; gap:1.25rem; align-items:baseline; padding:1rem 1.25rem;
           border-bottom:1px solid var(--line); flex-wrap:wrap; }
  h1 { font-size:1.05rem; margin:0; font-weight:650; }
  nav button { font:inherit; background:none; border:0; color:var(--dim); cursor:pointer;
               padding:.2rem 0; border-bottom:2px solid transparent; }
  nav button[aria-current="true"] { color:var(--fg); border-bottom-color:var(--fg); }
  nav { display:flex; gap:1rem; }
  main { padding:1.25rem; max-width:72rem; }
  section[hidden] { display:none; }
  h2 { font-size:.95rem; color:var(--dim); font-weight:650; margin:1.5rem 0 .5rem; }
  code, textarea, pre { font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  textarea { width:100%; min-height:14rem; padding:.75rem; border:1px solid var(--line);
             border-radius:6px; background:var(--panel); color:var(--fg); }
  button.go { font:inherit; padding:.4rem .9rem; border:1px solid var(--line);
              border-radius:6px; background:var(--panel); color:var(--fg); cursor:pointer; }
  table { border-collapse:collapse; width:100%; margin:.5rem 0 1rem; font-size:14px; }
  th,td { text-align:left; padding:.35rem .6rem; border-bottom:1px solid var(--line);
          vertical-align:top; }
  th { color:var(--dim); font-weight:600; }
  .dim { color:var(--dim); } .none { color:var(--dim); font-style:italic; }
  .ok { color:var(--ok); font-weight:600; } .bad { color:var(--bad); font-weight:600; }
  .warn { color:var(--warn); }
  .badge { display:inline-block; padding:0 .4rem; border-radius:3px; font-size:12px;
           border:1px solid var(--line); }
  .banner { border-left:3px solid var(--warn); padding:.5rem .9rem; margin:1rem 0;
            background:var(--panel); }
  .banner.err { border-left-color:var(--bad); }
  .wrap { overflow-x:auto; }
  .row { display:flex; gap:.75rem; align-items:center; flex-wrap:wrap; margin:.5rem 0; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(15rem,1fr)); gap:.5rem; }
  .cell { border:1px solid var(--line); border-radius:6px; padding:.5rem .7rem; background:var(--panel); }
  .cell.running { border-color:var(--warn); }
  .cell.error { border-color:var(--bad); }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:.1rem .9rem; margin:.4rem 0; }
  dt { color:var(--dim); } dd { margin:0; }
</style></head><body>

<header>
  <h1>duva-bench</h1>
  <nav>
    <button id="tab-define" aria-current="true">Define</button>
    <button id="tab-monitor">Monitor</button>
    <button id="tab-analyze">Analyze</button>
  </nav>
  <span class="dim" id="conn"></span>
</header>

<main>
  <section id="view-define">
    <div class="row">
      <select id="spec-pick"></select>
      <button class="go" id="load">Load</button>
      <button class="go" id="validate">Validate &amp; digest</button>
    </div>
    <textarea id="spec" spellcheck="false" placeholder="Paste a study spec (YAML or JSON), or pick one above."></textarea>
    <div id="define-out"></div>
  </section>

  <section id="view-monitor" hidden>
    <div class="row"><span class="dim" id="monitor-status">connecting…</span></div>
    <div class="grid" id="trial-grid"></div>
    <h2>Progress log</h2>
    <div class="wrap"><table id="progress-table">
      <thead><tr><th>#</th><th>kind</th><th>detail</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section id="view-analyze" hidden>
    <div class="row">
      <select id="report-pick"></select>
      <button class="go" id="analyze">Read from ADP</button>
    </div>
    <div id="analyze-out"></div>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
const n3 = (v) => (v === null || v === undefined ? '<span class="none">&mdash;</span>' : Number(v).toFixed(3));
// Unscored is a word and unpriced is a word. Rendering either as a number is
// the single most misleading thing this page could do.
const score = (v) => (v === null || v === undefined ? '<span class="none">unscored</span>' : Number(v).toFixed(3));
const usd = (micro) => (micro === null || micro === undefined ? '<span class="none">unpriced</span>' : '$' + (micro / 1e6).toFixed(4));

let CONFIG = { specs: [] };

function show(which) {
  for (const name of ['define', 'monitor', 'analyze']) {
    $('view-' + name).hidden = name !== which;
    $('tab-' + name).setAttribute('aria-current', String(name === which));
  }
}
for (const name of ['define', 'monitor', 'analyze']) {
  $('tab-' + name).onclick = () => show(name);
}

// ── Define ────────────────────────────────────────────────────────────
async function validate() {
  const text = $('spec').value.trim();
  // The editor's contents win when there are any; the server parses YAML, so
  // the page never has to.
  // basePath lets the server resolve the spec's relative paths and hash its
  // graders, so the digest shown here is the digest the scheduler will use.
  const body = text ? { text: text, basePath: $('spec-pick').value } : { file: $('spec-pick').value };
  const res = await fetch('/api/validate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json();
  $('define-out').innerHTML = data.ok ? renderDefine(data) : renderErrors(data.errors);
}

function renderErrors(errors) {
  return '<div class="banner err"><strong>' + (errors || []).length + ' problem(s)</strong><ul>' +
    (errors || []).map((e) => '<li><code>' + esc(e.path) + '</code> — ' + esc(e.message) + '</li>').join('') +
    '</ul></div>';
}

function renderDefine(d) {
  const pre = d.preRegistration;
  const diff = pre.amended
    ? '<div class="banner"><strong>Amended.</strong> Registered ' +
      '<code>' + esc(pre.registered.primaryMetric) + '</code> / ' + pre.registered.repetitions + ' reps ' +
      '(<code>' + esc(pre.registeredDigest.slice(0, 12)) + '</code>) → now ' +
      '<code>' + esc(pre.current.primaryMetric) + '</code> / ' + pre.current.repetitions + ' reps ' +
      '(<code>' + esc(pre.currentDigest.slice(0, 12)) + '</code>). Both readings remain computable.</div>'
    : '<p class="dim">Pre-registration unchanged since it was registered.</p>';

  return '<h2>Digest</h2><dl>' +
    '<dt>study</dt><dd><code>' + esc(d.digest) + '</code></dd>' +
    '<dt>trials</dt><dd>' + d.trials + '</dd></dl>' +
    '<h2>Arms</h2><div class="wrap"><table><thead><tr><th>arm</th><th>digest</th><th>harness</th>' +
    '<th>topology</th><th>toolset</th></tr></thead><tbody>' +
    d.arms.map((a) => '<tr><td>' + esc(a.id) + '</td><td><code class="dim">' + esc(a.digest.slice(0, 12)) +
      '</code></td><td>' + esc(a.harness) + '</td><td>' + esc(a.topology) + '</td><td>' + esc(a.toolset) +
      (a.twinned ? ' <span class="badge">twin</span>' : '') + '</td></tr>').join('') +
    '</tbody></table></div><h2>Pre-registration</h2>' + diff;
}

$('validate').onclick = validate;
$('load').onclick = async () => {
  const file = $('spec-pick').value;
  if (!file) return;
  const res = await fetch('/api/spec?file=' + encodeURIComponent(file));
  if (!res.ok) return;
  $('spec').value = (await res.json()).text;
};

// ── Monitor ───────────────────────────────────────────────────────────
const trials = new Map();

function paintGrid() {
  $('trial-grid').innerHTML = [...trials.entries()].sort().map(([ref, t]) => {
    const cls = t.state === 'running' ? ' running' : (t.verdict === 'ERROR' ? ' error' : '');
    const badge = t.state === 'running'
      ? '<span class="warn">running</span>'
      : t.verified === true ? '<span class="ok">verify ok</span>'
      : t.verified === false ? '<span class="bad">ERROR</span>'
      : t.state === 'skipped' ? '<span class="dim">skipped</span>'
      : t.state === 'failed' ? '<span class="bad">failed</span>'
      : '<span class="dim">' + esc(t.state) + '</span>';
    return '<div class="cell' + cls + '"><code>' + esc(ref) + '</code><br>' + badge +
      (t.usd !== undefined && t.usd !== null ? ' <span class="dim">$' + Number(t.usd).toFixed(3) + '</span>' : '') +
      '</div>';
  }).join('');
}

function applyFrame(f) {
  if (!f || !f.kind) return;
  if (f.externalRef) {
    const t = trials.get(f.externalRef) || {};
    if (f.kind === 'started') { t.state = 'running'; }
    else if (f.kind === 'finished') { t.state = 'finished'; t.verified = f.verified; t.usd = f.usd;
                                      t.verdict = f.verified === true ? 'ok' : 'ERROR'; }
    else if (f.kind === 'skipped') { t.state = 'skipped'; t.verified = true; }
    else if (f.kind === 'failed') { t.state = 'failed'; }
    trials.set(f.externalRef, t);
  }
  const body = $('progress-table').querySelector('tbody');
  const tr = document.createElement('tr');
  tr.innerHTML = '<td class="dim">' + (body.children.length + 1) + '</td><td>' + esc(f.kind) +
    '</td><td><code>' + esc(f.externalRef || f.taskId || f.digest || '') + '</code></td>';
  body.appendChild(tr);
  paintGrid();
}

let stream;
function connect() {
  stream = new EventSource('/api/progress/stream');
  stream.addEventListener('progress', (e) => applyFrame(JSON.parse(e.data)));
  stream.onopen = () => { $('conn').textContent = 'live'; $('monitor-status').textContent = 'live'; };
  // The browser reconnects on its own with Last-Event-ID, and the server
  // resumes from that line of progress.jsonl — so a restart loses no frames.
  stream.onerror = () => { $('conn').textContent = 'reconnecting…'; };
}

// ── Analyze ───────────────────────────────────────────────────────────
async function analyze() {
  const file = $('report-pick').value;
  if (!file) return;
  $('analyze-out').innerHTML = '<p class="dim">reading ADP…</p>';
  const res = await fetch('/api/report?file=' + encodeURIComponent(file));
  const data = await res.json();
  if (!res.ok) { $('analyze-out').innerHTML = renderErrors(data.errors || [{ path: '', message: data.error }]); return; }
  $('analyze-out').innerHTML = renderReport(data);
}

function renderReport(r) {
  const axes = [...new Set(r.cells.flatMap((c) => Object.keys(c.axes)))].sort();

  // Bands, never one ordering. Two arms that did not run the same program are
  // not rankable against each other whatever their scores say.
  const bands = new Map();
  for (const a of r.study.arms) {
    const key = a.harness + '/' + a.topology;
    bands.set(key, (bands.get(key) || []).concat(a.id));
  }
  const banded = bands.size > 1
    ? '<div class="banner"><strong>' + bands.size + ' bands.</strong> ' +
      [...bands.entries()].map(([k, v]) => esc(k) + ' [' + v.map(esc).join(', ') + ']').join(' &middot; ') +
      ' — arms in different bands ran different programs and must not be ranked together.</div>'
    : '';

  const digests = new Set(r.study.arms.map((a) => a.digest));
  const mismatch = digests.size !== r.study.arms.length
    ? '<div class="banner"><strong>Digest collision.</strong> Two arms share an arm digest, so they are the same cell under two names.</div>'
    : '';

  const errors = r.counts.errors > 0
    ? '<div class="banner err"><strong>' + r.counts.errors + ' ERROR</strong> — excluded from every statistic, never scored as zero. ' +
      Object.entries(r.exclusions).map(([k, v]) => '<code>' + esc(k) + '</code> ' + v).join(', ') + '</div>'
    : '';

  const floors = r.noiseFloors.length
    ? '<table><thead><tr><th>axis</th><th>pooled sd</th><th>cells</th></tr></thead><tbody>' +
      r.noiseFloors.map((f) => '<tr><td>' + esc(f.axis) + '</td><td>' + n3(f.sd) + '</td><td>' + f.cells + '</td></tr>').join('') +
      '</tbody></table>'
    : '<p class="none">Not measurable — no cell has repeated trials.</p>';

  const perAxis = axes.map((axis) =>
    '<h2>' + esc(axis) + '</h2><div class="wrap"><table><thead><tr><th>arm</th><th>task</th><th>n</th>' +
    '<th>mean</th><th>sd</th></tr></thead><tbody>' +
    r.cells.map((c) => '<tr><td>' + esc(c.armId) + '</td><td>' + esc(c.taskId) + '</td><td>' + c.n +
      '</td><td>' + (c.axes[axis] ? score(c.axes[axis].mean) : score(null)) + '</td><td>' +
      (c.axes[axis] ? n3(c.axes[axis].sd) : n3(null)) + '</td></tr>').join('') +
    '</tbody></table></div>').join('');

  const rows = r.trials.map((t) =>
    '<tr><td><code>' + esc(t.externalRef) + '</code></td>' +
    '<td>' + (t.verdict === 'ok' ? '<span class="ok">ok</span>' : '<span class="bad">' + esc(t.verdict) + '</span>') + '</td>' +
    '<td>' + score(t.axes[r.preRegistration.current.primaryMetric]) + '</td>' +
    '<td>' + n3(t.hallucinatedCallRate) + '</td><td>' + t.toolCalls + '</td><td>' + t.steps + '</td>' +
    '<td>' + usd(t.costMicroUsd) + '</td>' +
    // Drill-down resolves through ADP by run id, not through local state.
    '<td>' + (t.runId ? '<a href="#" data-run="' + esc(t.runId) + '">trajectory</a>' : '') + '</td></tr>').join('');

  return banded + mismatch + errors +
    '<h2>Noise floor</h2><p class="dim">Read before any contrast.</p>' + floors +
    perAxis +
    '<h2>Trials</h2><div class="wrap"><table><thead><tr><th>external_ref</th><th>verify</th>' +
    '<th>' + esc(r.preRegistration.current.primaryMetric) + '</th><th>halluc.</th><th>tools</th>' +
    '<th>steps</th><th>cost</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '<div id="drill"></div>';
}

document.addEventListener('click', async (e) => {
  const runId = e.target && e.target.dataset && e.target.dataset.run;
  if (!runId) return;
  e.preventDefault();
  const res = await fetch('/api/run/' + encodeURIComponent(runId) + '/trajectory');
  const body = await res.json();
  const events = (body.events || []).slice(0, 60);
  $('drill').innerHTML = '<h2>Trajectory ' + esc(runId.slice(0, 8)) + '</h2><div class="wrap"><table>' +
    '<thead><tr><th>seq</th><th>kind</th><th>type</th><th>status</th></tr></thead><tbody>' +
    events.map((ev) => '<tr><td class="dim">' + ev.seq + '</td><td>' + esc(ev.kind) + '</td><td><code>' +
      esc(ev.type) + '</code></td><td>' + esc(ev.status || '') + '</td></tr>').join('') +
    '</tbody></table></div>';
});

$('analyze').onclick = analyze;

// ── Boot ──────────────────────────────────────────────────────────────
(async () => {
  CONFIG = await (await fetch('/api/config')).json();
  const options = (CONFIG.specs || []).map((s) => '<option value="' + esc(s) + '">' + esc(s.split('/').pop()) + '</option>').join('');
  $('spec-pick').innerHTML = options;
  $('report-pick').innerHTML = options;
  connect();
})();
</script>
</body></html>`;
