/**
 * The dashboard, served as one self-contained page. No build step and no
 * external resources: the CSP on this route forbids them, and an internal DNS
 * console should not depend on a CDN being reachable.
 *
 * Every value that came from the API is inserted with textContent or
 * createElement, never innerHTML, so a hostile TXT record or comment cannot
 * script the page.
 */
export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>priv-dns</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #fff; --ink: #14171a; --muted: #666e77;
    --line: #dfe3e8; --danger: #a32a2a; --code: #f0f2f5;
    /* Cloudflare orange. --accent carries white text so it is darkened to
       clear WCAG AA; --brand is the pure brand tone, used only where it sits
       on a neutral ground and never as a text-on-fill pair. */
    --accent: #b85206; --brand: #f6821f; --on-accent: #fff;
    --wash: #fff6ee;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16181c; --panel: #1e2126; --ink: #e8eaed; --muted: #9aa3ad;
      --line: #30353c; --danger: #e08585; --code: #14161a;
      /* On dark, the brand tone is bright enough to take dark text. */
      --accent: #f6821f; --brand: #fbad41; --on-accent: #241505;
      --wash: #2a1c10;
    }
  }
  * { box-sizing: border-box; }
  /* An author rule setting display beats the UA stylesheet's [hidden] rule,
     so state the intent explicitly rather than relying on the default. */
  [hidden] { display: none !important; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    padding: 12px 20px; background: var(--panel);
    border-top: 3px solid var(--brand);
    border-bottom: 1px solid var(--line);
    position: sticky; top: 0; z-index: 5;
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  }
  h1 {
    font-size: 16px; margin: 0; font-weight: 650; letter-spacing: -0.01em;
    display: flex; align-items: center; gap: 7px;
  }
  h1::before {
    content: ""; width: 9px; height: 9px; border-radius: 50%;
    background: var(--brand); flex: none;
  }
  .grow { flex: 1; }
  /* Takes the slack on desktop; drops to its own full-width row on a phone. */
  header #filter { flex: 1 1 220px; min-width: 0; }
  main { padding: 20px; max-width: 1180px; margin: 0 auto; }
  .panel {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 8px; padding: 16px; margin-bottom: 18px;
  }
  .panel h2 {
    font-size: 13px; margin: 0 0 12px; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--muted); font-weight: 600;
    display: flex; align-items: center; gap: 8px;
  }
  .panel h2::before {
    content: ""; width: 3px; height: 12px; border-radius: 2px;
    background: var(--brand);
  }
  label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  input, select, button, textarea {
    font: inherit; color: var(--ink); background: var(--panel);
    border: 1px solid var(--line); border-radius: 6px; padding: 7px 9px;
  }
  input:focus, select:focus, button:focus-visible {
    outline: 2px solid var(--brand); outline-offset: 1px;
  }
  input:focus, select:focus { outline-offset: -1px; }
  button {
    cursor: pointer; background: var(--accent); color: var(--on-accent);
    border-color: transparent; font-weight: 600; padding: 7px 14px;
  }
  button:hover { filter: brightness(1.1); }
  button.ghost {
    background: transparent; color: var(--ink); border-color: var(--line);
    font-weight: 550;
  }
  button.ghost:hover { border-color: var(--brand); color: var(--accent); filter: none; }
  button.danger { background: transparent; color: var(--danger); border-color: transparent;
    padding: 4px 8px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  .row > div { min-width: 130px; }
  .row > div.wide { flex: 1; min-width: 220px; }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--muted); padding: 6px 8px;
    border-bottom: 1px solid var(--line); font-weight: 600;
  }
  td { padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  td.mono, .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
  }
  .type-badge {
    display: inline-block; padding: 1px 7px; border-radius: 4px;
    background: var(--wash); color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--brand) 35%, transparent);
    font-size: 11px; font-weight: 650; font-family: ui-monospace, monospace;
  }
  .comment { color: var(--muted); font-size: 13px; }
  .meta { color: var(--muted); font-size: 12px; }
  footer {
    max-width: 1180px; margin: 0 auto; padding: 4px 20px 32px;
    display: flex; flex-wrap: wrap; gap: 4px 16px; line-height: 1.7;
  }
  footer .k { opacity: 0.75; }
  footer .v { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre {
    background: var(--code); padding: 14px; border-radius: 6px;
    overflow-x: auto; font-size: 12.5px; margin: 0; line-height: 1.45;
  }
  #toast {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: var(--ink); color: var(--bg); padding: 10px 18px;
    border-radius: 6px; font-size: 13px; max-width: 90vw;
  }
  #toast.err { background: var(--danger); color: #fff; }
  .empty { color: var(--muted); padding: 20px; text-align: center; }
  #devBanner {
    background: #8a5a00; color: #fff; padding: 7px 20px; font-size: 13px;
    font-weight: 550; display: flex; gap: 8px; align-items: center;
  }
  .actions { text-align: right; white-space: nowrap; }

  /* ---- phones and narrow windows -------------------------------------- */
  /* Six columns cannot survive a phone, so each row becomes its own card
     with the column header carried in a data-label. */
  @media (max-width: 760px) {
    main { padding: 12px; }
    .panel { padding: 12px; border-radius: 6px; }
    header { padding: 10px 12px; }
    header h1 { flex: 1 1 auto; }
    header #filter { flex: 1 0 100%; order: 3; }
    header button { order: 2; }
    footer { padding: 4px 12px 28px; }

    .row { display: block; }
    .row > div, .row > div.wide { min-width: 0; margin-bottom: 10px; }
    #dataFields { display: block; }
    #dataFields input, .row input, .row select { width: 100% !important; }
    #addBtn { width: 100%; padding: 11px; }

    table, thead, tbody, tr, td { display: block; width: 100%; }
    thead { display: none; }
    tr {
      border: 1px solid var(--line); border-radius: 6px;
      padding: 10px; margin-bottom: 10px;
    }
    td { border: none; padding: 3px 0; display: flex; gap: 10px; }
    td::before {
      content: attr(data-label); flex: 0 0 78px; color: var(--muted);
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
      padding-top: 2px;
    }
    td:empty { display: none; }
    td.actions { justify-content: flex-start; padding-top: 8px; }
    td.actions::before { content: ""; flex: 0 0 78px; }
    /* Comfortable touch targets - 24px buttons are not tappable. */
    td.actions button { padding: 9px 16px; }
    /* The editor sets pixel widths inline, which beat a plain rule here. */
    td input, td .mono { width: 100% !important; }
  }

  @media (max-width: 420px) {
    td { display: block; }
    td::before { display: block; flex: none; margin-bottom: 1px; }
    td.actions::before { display: none; }
  }
</style>
</head>
<body>
<div id="devBanner" hidden>
  <span>&#9888;</span>
  <span>Local development mode &mdash; authentication is disabled. Never expose this instance.</span>
</div>
<header>
  <h1>priv-dns</h1>
  <select id="zoneSelect" aria-label="Zone"></select>
  <input id="filter" type="search" placeholder="Filter name, value, comment"
         aria-label="Filter records">
  <button class="ghost" id="toggleZoneFile">Zone file</button>
  <button class="ghost" id="refresh">Refresh</button>
</header>

<main>
  <section class="panel" id="addPanel">
    <h2>Add record</h2>
    <div class="row">
      <div>
        <label for="f-name">Name</label>
        <input id="f-name" class="mono" placeholder="nas" size="14">
      </div>
      <div>
        <label for="f-type">Type</label>
        <select id="f-type"></select>
      </div>
      <div id="dataFields" class="row" style="gap:10px"></div>
      <div>
        <label for="f-ttl">TTL</label>
        <input id="f-ttl" type="number" min="0" max="604800" value="300" size="6"
               style="width:92px">
      </div>
      <div class="wide">
        <label for="f-comment">Comment</label>
        <input id="f-comment" placeholder="Synology in the rack" maxlength="200">
      </div>
      <div><button id="addBtn">Add</button></div>
    </div>
  </section>

  <section class="panel" id="zoneFilePanel" hidden>
    <h2>Rendered zone file</h2>
    <pre id="zoneFile"></pre>
  </section>

  <section class="panel">
    <h2>Records (<span id="count">0</span>)</h2>
    <table>
      <thead>
        <tr>
          <th style="width:20%">Name</th>
          <th style="width:70px">Type</th>
          <th style="width:70px">TTL</th>
          <th style="width:30%">Value</th>
          <th>Comment</th>
          <th style="width:130px"></th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="empty" id="emptyState" hidden>No records match.</div>
  </section>
</main>

<footer id="zoneMeta" class="meta"></footer>

<script>
(function () {
  'use strict';

  var TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'PTR'];

  // Which inputs each record type needs, and how to assemble/format its data.
  var SHAPES = {
    A:     [{ k: 'ip', label: 'IPv4 address', ph: '10.10.0.20', w: 150 }],
    AAAA:  [{ k: 'ip', label: 'IPv6 address', ph: 'fd00::20', w: 190 }],
    CNAME: [{ k: 'target', label: 'Target', ph: 'nas', w: 190 }],
    NS:    [{ k: 'target', label: 'Target', ph: 'ns1.example.', w: 190 }],
    PTR:   [{ k: 'target', label: 'Target', ph: 'nas.example.', w: 190 }],
    TXT:   [{ k: 'text', label: 'Text', ph: 'v=spf1 -all', w: 260 }],
    MX:    [{ k: 'preference', label: 'Pref', num: true, ph: '10', w: 70 },
            { k: 'exchange', label: 'Exchange', ph: 'mail', w: 170 }],
    SRV:   [{ k: 'priority', label: 'Prio', num: true, ph: '10', w: 66 },
            { k: 'weight', label: 'Weight', num: true, ph: '5', w: 66 },
            { k: 'port', label: 'Port', num: true, ph: '443', w: 74 },
            { k: 'target', label: 'Target', ph: 'host', w: 150 }]
  };

  var state = { zones: [], origin: null, records: [], etag: null, zone: null };

  var $ = function (id) { return document.getElementById(id); };

  function toast(message, isError) {
    var existing = $('toast');
    if (existing) existing.remove();
    var el = document.createElement('div');
    el.id = 'toast';
    if (isError) el.className = 'err';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.remove(); }, isError ? 6000 : 2800);
  }

  function api(path, options) {
    var opts = options || {};
    opts.credentials = 'include';
    opts.headers = opts.headers || {};
    if (opts.body) opts.headers['Content-Type'] = 'application/json';
    return fetch(path, opts).then(function (res) {
      // Access sessions expire; bounce through the login rather than showing
      // a bare 401 the operator can do nothing with.
      if (res.status === 401) { location.reload(); throw new Error('unauthorized'); }
      if (res.status === 304) return { ok: true, data: null };
      return res.json().then(function (body) {
        if (!res.ok || !body.ok) {
          throw new Error((body.error && body.error.message) || ('HTTP ' + res.status));
        }
        body.__etag = res.headers.get('ETag');
        return body;
      });
    });
  }

  /* ------------------------------------------------------------ rendering */

  function formatValue(record) {
    var d = record.data || {};
    switch (record.type) {
      case 'A': case 'AAAA': return d.ip;
      case 'CNAME': case 'NS': case 'PTR': return d.target;
      case 'TXT': return '"' + d.text + '"';
      case 'MX': return d.preference + ' ' + d.exchange;
      case 'SRV':
        return d.priority + ' ' + d.weight + ' ' + d.port + ' ' + d.target;
      default: return JSON.stringify(d);
    }
  }

  function cell(row, text, className, label) {
    var td = document.createElement('td');
    if (className) td.className = className;
    if (label) td.setAttribute('data-label', label);
    td.textContent = text == null ? '' : String(text);
    row.appendChild(td);
    return td;
  }

  function renderRows() {
    var tbody = $('rows');
    tbody.textContent = '';
    var needle = $('filter').value.trim().toLowerCase();

    var visible = state.records.filter(function (r) {
      if (!needle) return true;
      var hay = (r.name + ' ' + r.type + ' ' + formatValue(r) + ' ' +
                 (r.comment || '')).toLowerCase();
      return hay.indexOf(needle) >= 0;
    });

    $('count').textContent = String(state.records.length);
    $('emptyState').hidden = visible.length > 0;

    visible.forEach(function (record) {
      var tr = document.createElement('tr');

      cell(tr, record.name, 'mono', 'Name');

      var typeTd = document.createElement('td');
      typeTd.setAttribute('data-label', 'Type');
      var badge = document.createElement('span');
      badge.className = 'type-badge';
      badge.textContent = record.type;
      typeTd.appendChild(badge);
      tr.appendChild(typeTd);

      cell(tr, record.ttl, 'mono', 'TTL');
      cell(tr, formatValue(record), 'mono', 'Value');
      cell(tr, record.comment || '', 'comment', 'Comment');

      var actions = document.createElement('td');
      actions.className = 'actions';

      var editBtn = document.createElement('button');
      editBtn.className = 'ghost';
      editBtn.textContent = 'Edit';
      editBtn.onclick = function () { startEdit(tr, record); };
      actions.appendChild(editBtn);

      var delBtn = document.createElement('button');
      delBtn.className = 'danger';
      delBtn.textContent = 'Delete';
      // A native confirm() would freeze the extension-driven session, and an
      // inline two-step is clearer anyway.
      delBtn.onclick = function () {
        if (delBtn.dataset.armed === '1') { removeRecord(record); return; }
        delBtn.dataset.armed = '1';
        delBtn.textContent = 'Sure?';
        setTimeout(function () {
          delBtn.dataset.armed = '';
          delBtn.textContent = 'Delete';
        }, 4000);
      };
      actions.appendChild(delBtn);

      tr.appendChild(actions);
      tbody.appendChild(tr);
    });
  }

  /** Swap a row into an inline editor for TTL, value and comment. */
  function startEdit(tr, record) {
    tr.textContent = '';
    cell(tr, record.name, 'mono', 'Name');

    var typeTd = document.createElement('td');
    typeTd.setAttribute('data-label', 'Type');
    var badge = document.createElement('span');
    badge.className = 'type-badge';
    badge.textContent = record.type;
    typeTd.appendChild(badge);
    tr.appendChild(typeTd);

    var ttlTd = document.createElement('td');
    ttlTd.setAttribute('data-label', 'TTL');
    var ttlInput = document.createElement('input');
    ttlInput.type = 'number';
    ttlInput.min = '0';
    ttlInput.max = '604800';
    ttlInput.value = String(record.ttl);
    ttlInput.style.width = '78px';
    ttlTd.appendChild(ttlInput);
    tr.appendChild(ttlTd);

    var valueTd = document.createElement('td');
    valueTd.setAttribute('data-label', 'Value');
    var fields = SHAPES[record.type] || [];
    var inputs = {};
    fields.forEach(function (field) {
      var input = document.createElement('input');
      input.className = 'mono';
      input.value = record.data[field.k] == null ? '' : String(record.data[field.k]);
      input.style.width = field.w + 'px';
      input.style.marginRight = '5px';
      input.title = field.label;
      valueTd.appendChild(input);
      inputs[field.k] = { el: input, num: !!field.num };
    });
    tr.appendChild(valueTd);

    var commentTd = document.createElement('td');
    commentTd.setAttribute('data-label', 'Comment');
    var commentInput = document.createElement('input');
    commentInput.maxLength = 200;
    commentInput.value = record.comment || '';
    commentInput.style.width = '100%';
    commentTd.appendChild(commentInput);
    tr.appendChild(commentTd);

    var actions = document.createElement('td');
    actions.className = 'actions';

    var save = document.createElement('button');
    save.textContent = 'Save';
    save.onclick = function () {
      var data = {};
      var valid = true;
      Object.keys(inputs).forEach(function (key) {
        var raw = inputs[key].el.value.trim();
        if (!raw) valid = false;
        data[key] = inputs[key].num ? Number(raw) : raw;
      });
      if (!valid) { toast('All value fields are required', true); return; }
      save.disabled = true;
      patchRecord(record.id, {
        ttl: Number(ttlInput.value),
        data: data,
        comment: commentInput.value
      });
    };
    actions.appendChild(save);

    var cancel = document.createElement('button');
    cancel.className = 'ghost';
    cancel.textContent = 'Cancel';
    cancel.onclick = renderRows;
    actions.appendChild(cancel);

    tr.appendChild(actions);
    (inputs[fields[0] && fields[0].k] || {}).el &&
      inputs[fields[0].k].el.focus();
  }

  /* ---------------------------------------------------------- the add form */

  function renderDataFields() {
    var wrap = $('dataFields');
    wrap.textContent = '';
    (SHAPES[$('f-type').value] || []).forEach(function (field) {
      var box = document.createElement('div');
      var label = document.createElement('label');
      label.textContent = field.label;
      var input = document.createElement('input');
      input.className = 'mono';
      input.placeholder = field.ph;
      input.dataset.key = field.k;
      if (field.num) input.dataset.num = '1';
      input.style.width = field.w + 'px';
      box.appendChild(label);
      box.appendChild(input);
      wrap.appendChild(box);
    });
  }

  function collectNewRecord() {
    var name = $('f-name').value.trim();
    if (!name) { toast('Name is required', true); return null; }

    var data = {};
    var inputs = $('dataFields').querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
      var value = inputs[i].value.trim();
      if (!value) { toast('All value fields are required', true); return null; }
      data[inputs[i].dataset.key] = inputs[i].dataset.num ? Number(value) : value;
    }

    return {
      name: name,
      type: $('f-type').value,
      ttl: Number($('f-ttl').value),
      data: data,
      comment: $('f-comment').value
    };
  }

  /* -------------------------------------------------------------- actions */

  function loadZones() {
    return api('/api/zones').then(function (body) {
      state.zones = body.data.zones.filter(function (z) { return z.enabled !== false; });
      var select = $('zoneSelect');
      select.textContent = '';
      state.zones.forEach(function (zone) {
        var option = document.createElement('option');
        option.value = zone.origin;
        option.textContent = zone.origin.replace(/\.$/, '');
        select.appendChild(option);
      });
      if (state.zones.length === 0) {
        toast('No zones configured yet', true);
        return;
      }
      state.origin = state.zones[0].origin;
      return loadZone();
    });
  }

  function loadZone() {
    if (!state.origin) return Promise.resolve();
    return api('/api/zones/' + encodeURIComponent(state.origin)).then(function (body) {
      state.zone = body.data.zone;
      state.records = body.data.zone.records;
      // Prefer the body value: Cloudflare rewrites the ETag header to a weak
      // form (W/"...") whenever it compresses the response, which it does for
      // every browser request.
      state.etag = body.data.etag || body.__etag;
      renderFooter();
      renderRows();
      if (!$('zoneFilePanel').hidden) loadZoneFile();
    });
  }

  /**
   * Who made the last change, in a form a person can read. A service token
   * arrives as "service-token:<client-id>.access", which is a wall of hex that
   * tells you nothing at a glance - show a short prefix instead.
   */
  function formatActor(actor) {
    if (!actor) return 'unknown';
    if (actor.indexOf('service-token:') !== 0) return actor;
    var id = actor.slice('service-token:'.length).replace(/\.access$/, '');
    return 'service token ' + id.slice(0, 8);
  }

  function renderFooter() {
    var footer = $('zoneMeta');
    footer.textContent = '';
    if (!state.zone) return;

    var when = new Date(state.zone.updatedAt);
    var parts = [
      ['Serial', String(state.zone.serial)],
      ['Updated', when.toLocaleString()],
      ['By', formatActor(state.zone.updatedBy)]
    ];
    parts.forEach(function (pair) {
      var wrap = document.createElement('span');
      var k = document.createElement('span');
      k.className = 'k';
      k.textContent = pair[0] + ' ';
      var v = document.createElement('span');
      v.className = 'v';
      v.textContent = pair[1];
      wrap.appendChild(k);
      wrap.appendChild(v);
      footer.appendChild(wrap);
    });
  }

  function loadZoneFile() {
    return fetch('/zone/' + encodeURIComponent(state.origin), { credentials: 'include' })
      .then(function (res) { return res.text(); })
      .then(function (text) { $('zoneFile').textContent = text; });
  }

  function addRecord() {
    var record = collectNewRecord();
    if (!record) return;
    $('addBtn').disabled = true;
    api('/api/zones/' + encodeURIComponent(state.origin) + '/records', {
      method: 'POST',
      headers: state.etag ? { 'If-Match': state.etag } : {},
      body: JSON.stringify(record)
    }).then(function () {
      $('f-name').value = '';
      $('f-comment').value = '';
      renderDataFields();
      toast('Record added');
      return loadZone();
    }).catch(function (err) {
      toast(err.message, true);
    }).finally(function () {
      $('addBtn').disabled = false;
    });
  }

  function patchRecord(id, patch) {
    api('/api/zones/' + encodeURIComponent(state.origin) + '/records/' +
        encodeURIComponent(id), {
      method: 'PATCH',
      headers: state.etag ? { 'If-Match': state.etag } : {},
      body: JSON.stringify(patch)
    }).then(function () {
      toast('Record updated');
      return loadZone();
    }).catch(function (err) {
      toast(err.message, true);
      renderRows();
    });
  }

  function removeRecord(record) {
    api('/api/zones/' + encodeURIComponent(state.origin) + '/records/' +
        encodeURIComponent(record.id), {
      method: 'DELETE',
      headers: state.etag ? { 'If-Match': state.etag } : {}
    }).then(function () {
      toast('Deleted ' + record.name + ' ' + record.type);
      return loadZone();
    }).catch(function (err) { toast(err.message, true); });
  }

  /* ----------------------------------------------------------------- wire */

  TYPES.forEach(function (type) {
    var option = document.createElement('option');
    option.value = type;
    option.textContent = type;
    $('f-type').appendChild(option);
  });

  $('f-type').addEventListener('change', renderDataFields);
  $('filter').addEventListener('input', renderRows);
  $('addBtn').addEventListener('click', addRecord);
  $('refresh').addEventListener('click', function () {
    loadZone().then(function () { toast('Reloaded'); });
  });
  $('zoneSelect').addEventListener('change', function (event) {
    state.origin = event.target.value;
    loadZone();
  });
  $('toggleZoneFile').addEventListener('click', function () {
    var panel = $('zoneFilePanel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) loadZoneFile();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && event.target.closest('#addPanel')) addRecord();
  });

  // Surface an unauthenticated instance rather than letting it look normal.
  fetch('/health', { credentials: 'include' })
    .then(function (res) { return res.json(); })
    .then(function (body) {
      if (body && body.data && body.data.devNoAuth) $('devBanner').hidden = false;
    })
    .catch(function () { /* health is advisory only */ });

  renderDataFields();
  loadZones().catch(function (err) { toast(err.message, true); });
})();
</script>
</body>
</html>`;
