// dashboard.js — "Server Dashboard" page, for admins only. Every change
// made on the shared server, from its audit log (server.mjs's
// _audit/<month>.jsonl, read through GET admin/audit): who did it, when,
// from where, and — for data — exactly what that save added, changed
// (which fields) and removed. For tracing a change back to the person
// who made it.
//
// The menu link is only shown to admins (sidebar.js), and the server
// refuses the log to anyone else; this page says so rather than showing
// an empty dashboard.
//
// A month at a time: an overview (how many changes of each kind, and
// by whom — pressing a person shows only theirs), then the changes
// themselves by day, newest first, each opening onto its details. A
// page of them is loaded at a time ("Show more"); the search looks
// through what's loaded. The month's changes, as filtered, can be
// downloaded as a CSV file.

const deniedEl = document.getElementById('dash-denied');
const deniedText = document.getElementById('dash-denied-text');
const bodyEl = document.getElementById('dash-body');
const monthSelect = document.getElementById('dash-month');
const refreshBtn = document.getElementById('dash-refresh');
const statsEl = document.getElementById('dash-stats');
const peopleEl = document.getElementById('dash-people');
const countEl = document.getElementById('dash-count');
const userSelect = document.getElementById('dash-user');
const kindSelect = document.getElementById('dash-kind');
const searchInput = document.getElementById('dash-search');
const noteEl = document.getElementById('dash-note');
const listEl = document.getElementById('dash-list');
const moreBtn = document.getElementById('dash-more');
const exportBtn = document.getElementById('dash-export');

const PAGE_SIZE = 200;
const CHEVRON_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// --- Words for what's in the log ---
const COLLECTION_LABELS = {
  history: 'Cert data',
  uutDatabase: 'Records',
  labLog: 'Lab log',
  customers: 'Customer folders',
  shareLog: 'Shared log',
  settings: 'Own settings',
  converter: 'Own converter',
  interpTabs: 'Open worksheets',
};

// A record's or a trip's fields, in words.
const FIELD_LABELS = {
  inAt: 'returned', outAt: 'taken out', returnedBy: 'returned by', takenBy: 'taken by', note: 'note',
  result: 'result', remarks: 'remarks', tables: 'readings', rows: 'readings', calDate: 'calibration date',
  technician: 'technician', customerId: 'folder', customerName: 'folder', uutModel: 'model', uutSerial: 'serial',
  uutTag: 'tag no.', uutMaker: 'maker', uutRange: 'range', uutResolution: 'resolution',
  ambientTemp: 'temperature at start', ambientHumidity: 'humidity at start', ambientPressure: 'pressure at start',
  endTemp: 'temperature at end', endHumidity: 'humidity at end', endPressure: 'pressure at end',
  savedAt: 'saved time', due: 'due date', certs: 'certificates', name: 'name', equipmentId: 'equipment',
  equipmentCert: 'certificate', equipmentName: 'description',
};

const KINDS = {
  data: { label: 'Data', test: (e) => e.action === 'save' },
  photos: { label: 'Photo', test: (e) => e.action === 'save-photo' },
  signin: { label: 'Sign-in', test: (e) => ['login', 'accept-invite', 'accept-transfer', 'create-transfer', 'change-own-password', 'change-own-name'].includes(e.action) },
  people: { label: 'People', test: (e) => ['add-person', 'remove-person', 'reset-password', 'turn-off-person', 'turn-on-person', 'change-person', 'create-invite'].includes(e.action) },
  others: { label: 'Others\' records', test: (e) => e.action === 'confirm-others-record' },
};

function kindOf(entry) {
  return Object.keys(KINDS).find((kind) => KINDS[kind].test(entry)) || 'other';
}

let names = {};

function personName(id) {
  if (!id) return 'Unknown';
  return names[id] || id;
}

// "Records", "Own settings", from "uutDatabase" or "people/ahmad/settings".
function collectionLabel(collection) {
  const name = String(collection || '').split('/').pop();
  return COLLECTION_LABELS[name] || name || 'Data';
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// What a save did, in a few words: "2 new · 1 changed · 1 removed".
function saveSummary(entry) {
  if (entry.updated !== undefined) return entry.updated ? 'Updated' : 'Saved, no change';
  const counts = entry.counts;
  if (!counts) return entry.items != null ? `Saved (${plural(entry.items, 'item')})` : 'Saved';
  const parts = [];
  if (counts.added) parts.push(`${counts.added} new`);
  if (counts.changed) parts.push(`${counts.changed} changed`);
  if (counts.removed) parts.push(`${counts.removed} removed`);
  return parts.join(' · ') || 'Saved, no change';
}

// The line that says what happened.
function describe(entry) {
  const person = entry.person ? personName(entry.person) : '';
  switch (entry.action) {
    case 'save': return `${collectionLabel(entry.collection)}: ${saveSummary(entry)}`;
    case 'save-photo': return 'Uploaded a photo';
    case 'login': return 'Signed in';
    case 'accept-invite': return 'Joined with an invite';
    case 'accept-transfer': return 'Signed in with a sign-in QR';
    case 'create-transfer': return 'Made a sign-in QR';
    case 'change-own-password': return 'Changed their password';
    case 'change-own-name': return 'Changed their name';
    case 'create-invite': return `Made an invite for ${person}`;
    case 'add-person': return `Added ${person}${entry.admin ? ' (admin)' : ''}`;
    case 'remove-person': return `Removed ${person}`;
    case 'reset-password': return `Reset ${person}'s password`;
    case 'turn-off-person': return `Turned off ${person}`;
    case 'turn-on-person': return `Turned on ${person}`;
    case 'change-person': return `Changed ${person}`;
    case 'confirm-others-record': {
      // Gave their password to change a record someone else saved.
      const verb = { edit: 'edit', move: 'move to another folder', delete: 'delete for everyone' }[entry.what] || 'change';
      const whose = entry.owner ? `${entry.owner}'s record` : 'someone else\'s record';
      return `Confirmed with their password to ${verb} ${whose}${entry.label ? ` “${entry.label}”` : ''}${entry.offline ? ' (with no connection)' : ''}`;
    }
    default: return entry.action || 'Change';
  }
}

// The first few names a save touched, for the line under it.
function firstNames(entry) {
  const all = [
    ...(entry.added || []),
    ...(entry.changed || []).map((c) => c && c.name),
    ...(entry.removed || []),
  ].filter(Boolean);
  if (all.length === 0) return '';
  return all.length > 2 ? `${all.slice(0, 2).join(', ')} and ${all.length - 2} more` : all.join(', ');
}

function fieldsText(fields) {
  return (fields || []).map((field) => FIELD_LABELS[field] || field).join(', ');
}

// Everything kept about one change.
function buildDetails(entry) {
  const body = el('div', 'sync-entry-body');
  const list = (heading, items) => {
    if (!items || items.length === 0) return;
    body.appendChild(el('p', 'sync-entry-line', heading));
    const ul = el('ul', 'sync-entry-items');
    items.forEach((text) => ul.appendChild(el('li', null, text)));
    body.appendChild(ul);
  };
  list('New', entry.added);
  list('Changed', (entry.changed || []).map((c) => (c.fields && c.fields.length ? `${c.name} — ${fieldsText(c.fields)}` : c.name)));
  list('Removed', entry.removed);
  const counts = entry.counts || {};
  const shown = (entry.added || []).length + (entry.changed || []).length + (entry.removed || []).length;
  const total = (counts.added || 0) + (counts.changed || 0) + (counts.removed || 0);
  if (total > shown) body.appendChild(el('p', 'camera-note', `Only the first ${shown} of ${total} are named.`));
  const facts = [
    ['When', new Date(entry.at).toLocaleString()],
    ['Who', `${personName(entry.user)}${entry.user && names[entry.user] ? ` (${entry.user})` : ''}`],
    entry.collection ? ['Where', collectionLabel(entry.collection)] : null,
    entry.items != null ? ['Items after', String(entry.items)] : null,
    entry.photo ? ['Photo', entry.photo] : null,
    entry.ip ? ['From', entry.ip] : null,
  ].filter(Boolean);
  const dl = el('dl', 'dash-facts');
  facts.forEach(([term, value]) => {
    dl.appendChild(el('dt', null, term));
    dl.appendChild(el('dd', null, value));
  });
  body.appendChild(dl);
  return body;
}

// --- State ---
const state = { month: '', user: '', kind: '', entries: [], total: 0, summary: null, months: [] };
const openDays = new Set();
const knownDays = new Set();
const openEntries = new Set();
let loading = 0;

function entryId(entry, index) {
  return `${entry.at}|${entry.user}|${entry.action}|${index}`;
}

function showNote(text, isError) {
  noteEl.textContent = text;
  noteEl.classList.toggle('hidden', !text);
  noteEl.classList.toggle('dash-note-error', Boolean(isError));
}

// --- Overview ---
function renderOverview() {
  const summary = state.summary || { total: 0, byUser: {}, byKind: {} };
  statsEl.innerHTML = '';
  [
    ['All changes', summary.total, ''],
    ['Data', summary.byKind.data || 0, 'data'],
    ['Photos', summary.byKind.photos || 0, 'photos'],
    ['Sign-ins', summary.byKind.signin || 0, 'signin'],
    ['People', summary.byKind.people || 0, 'people'],
    ['Others\' records', summary.byKind.others || 0, 'others'],
  ].forEach(([label, value, kind]) => {
    const tile = el('button', `dash-stat${state.kind === kind ? ' active' : ''}`);
    tile.type = 'button';
    tile.appendChild(el('span', 'dash-stat-value', String(value)));
    tile.appendChild(el('span', 'dash-stat-label', label));
    tile.addEventListener('click', () => {
      kindSelect.value = kind;
      changeFilters();
    });
    statsEl.appendChild(tile);
  });

  peopleEl.innerHTML = '';
  const people = Object.entries(summary.byUser).sort((a, b) => b[1] - a[1]);
  if (people.length === 0) {
    peopleEl.appendChild(el('p', 'history-empty', 'No changes this month.'));
    return;
  }
  const most = people[0][1] || 1;
  people.forEach(([id, count]) => {
    const row = el('button', `dash-person${state.user === id ? ' active' : ''}`);
    row.type = 'button';
    row.title = state.user === id ? 'Show everyone' : `Show only ${personName(id)}'s changes`;
    row.appendChild(el('span', 'dash-person-name', personName(id)));
    const bar = el('span', 'dash-person-bar');
    const fill = el('span', 'dash-person-fill');
    fill.style.width = `${Math.max(4, Math.round((count / most) * 100))}%`;
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(el('span', 'dash-person-count', String(count)));
    row.addEventListener('click', () => {
      userSelect.value = state.user === id ? '' : id;
      changeFilters();
    });
    peopleEl.appendChild(row);
  });
}

function renderFilters() {
  monthSelect.innerHTML = '';
  const months = state.months.includes(state.month) ? state.months : [state.month, ...state.months];
  months.forEach((month) => {
    const option = el('option', null, new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
    option.value = month;
    monthSelect.appendChild(option);
  });
  monthSelect.value = state.month;

  const ids = new Set([...Object.keys(names), ...Object.keys((state.summary && state.summary.byUser) || {})]);
  const current = state.user;
  userSelect.innerHTML = '';
  userSelect.appendChild(el('option', null, 'Everyone')).value = '';
  [...ids].sort((a, b) => personName(a).localeCompare(personName(b))).forEach((id) => {
    userSelect.appendChild(el('option', null, personName(id))).value = id;
  });
  userSelect.value = current;
  kindSelect.value = state.kind;
}

// --- Activity ---
function matchesSearch(entry) {
  const query = searchInput.value.trim().toLowerCase();
  if (!query) return true;
  return [
    describe(entry), personName(entry.user), entry.user, entry.person, entry.collection, entry.ip,
    ...(entry.added || []), ...(entry.removed || []), ...(entry.changed || []).map((c) => c && c.name),
  ].filter(Boolean).join(' ').toLowerCase().includes(query);
}

function renderActivity() {
  const shown = state.entries.map((entry, index) => ({ entry, id: entryId(entry, index) })).filter(({ entry }) => matchesSearch(entry));
  const searching = Boolean(searchInput.value.trim());
  countEl.textContent = searching ? `(${shown.length} of ${state.entries.length} loaded)` : `(${state.total})`;
  listEl.innerHTML = '';
  moreBtn.classList.toggle('hidden', state.entries.length >= state.total);
  moreBtn.textContent = `Show more (${state.total - state.entries.length} left)`;

  if (shown.length === 0) {
    listEl.appendChild(el('p', 'history-empty', searching ? 'Nothing loaded matches that.' : 'No changes to show.'));
    return;
  }

  const groups = new Map();
  shown.forEach((item) => {
    const key = dayKey(item.entry.at);
    if (!groups.has(key)) groups.set(key, { key, label: formatDay(item.entry.at), items: [] });
    groups.get(key).items.push(item);
  });
  const ordered = Array.from(groups.values()).sort((a, b) => b.key.localeCompare(a.key));
  ordered.forEach((group, index) => {
    if (!knownDays.has(group.key)) {
      knownDays.add(group.key);
      if (index === 0) openDays.add(group.key);
    }
    const open = searching || openDays.has(group.key);
    const day = el('div', 'lab-day');
    const header = el('div', 'lab-day-header');
    const heading = el('h3', 'day-heading');
    const toggle = el('button', 'day-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.innerHTML = CHEVRON_ICON;
    toggle.appendChild(el('span', 'day-toggle-label', group.label));
    toggle.appendChild(el('span', 'day-toggle-summary', plural(group.items.length, 'change')));
    toggle.addEventListener('click', () => {
      if (openDays.has(group.key)) openDays.delete(group.key);
      else openDays.add(group.key);
      renderActivity();
    });
    heading.appendChild(toggle);
    header.appendChild(heading);
    day.appendChild(header);
    if (open) group.items.forEach(({ entry, id }) => day.appendChild(buildRow(entry, id)));
    listEl.appendChild(day);
  });
}

function buildRow(entry, id) {
  const wrap = el('div', 'sync-entry');
  const row = el('div', 'history-item lab-event');
  row.appendChild(el('span', 'lab-event-time', formatTime(entry.at)));
  const kind = kindOf(entry);
  row.appendChild(el('span', `lab-badge sync-badge dash-badge-${kind}`, (KINDS[kind] && KINDS[kind].label) || 'Other'));
  const open = openEntries.has(id);
  const info = el('button', 'history-item-info sync-entry-toggle');
  info.type = 'button';
  info.setAttribute('aria-expanded', String(open));
  info.title = open ? 'Hide the details' : 'Show the details';
  info.appendChild(el('span', 'history-item-id', describe(entry)));
  const meta = [personName(entry.user), firstNames(entry)].filter(Boolean).join(' · ');
  info.appendChild(el('span', 'history-item-meta', meta));
  info.addEventListener('click', () => {
    if (openEntries.has(id)) openEntries.delete(id);
    else openEntries.add(id);
    renderActivity();
  });
  row.appendChild(info);
  wrap.appendChild(row);
  if (open) wrap.appendChild(buildDetails(entry));
  return wrap;
}

// --- Loading ---
async function load(more) {
  const ticket = ++loading;
  refreshBtn.disabled = true;
  moreBtn.disabled = true;
  showNote(more ? '' : 'Loading…');
  try {
    const data = await loadServerAudit({
      month: state.month, user: state.user, kind: state.kind, offset: more ? state.entries.length : 0, limit: PAGE_SIZE,
    });
    if (ticket !== loading) return;
    state.month = data.month;
    state.months = Array.isArray(data.months) ? data.months : [];
    state.summary = data.summary;
    state.total = data.total || 0;
    state.entries = more ? [...state.entries, ...(data.entries || [])] : (data.entries || []);
    showNote('');
    renderFilters();
    renderOverview();
    renderActivity();
  } catch (err) {
    if (ticket !== loading) return;
    showNote(err.message, true);
  } finally {
    if (ticket === loading) {
      refreshBtn.disabled = false;
      moreBtn.disabled = false;
    }
  }
}

function changeFilters() {
  state.month = monthSelect.value;
  state.user = userSelect.value;
  state.kind = kindSelect.value;
  openEntries.clear();
  load(false);
}

monthSelect.addEventListener('change', () => {
  knownDays.clear();
  openDays.clear();
  changeFilters();
});
userSelect.addEventListener('change', changeFilters);
kindSelect.addEventListener('change', changeFilters);
refreshBtn.addEventListener('click', () => load(false));
moreBtn.addEventListener('click', () => load(true));
searchInput.addEventListener('input', renderActivity);

// --- CSV ---
// Everything matching the month, person and kind (not only what's
// loaded), one change per line, for a spreadsheet.
function csvCell(value) {
  const text = value == null ? '' : String(value);
  // A cell starting like a formula is kept as text, not run.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

exportBtn.addEventListener('click', async () => {
  exportBtn.disabled = true;
  showNote('Preparing the file…');
  try {
    const all = [];
    for (let offset = 0; ; offset += 500) {
      const data = await loadServerAudit({ month: state.month, user: state.user, kind: state.kind, offset, limit: 500 });
      all.push(...(data.entries || []));
      if (all.length >= (data.total || 0) || !(data.entries || []).length) break;
    }
    const rows = [['Time', 'Login ID', 'Name', 'Kind', 'What', 'New', 'Changed', 'Removed', 'From']];
    all.forEach((entry) => {
      rows.push([
        new Date(entry.at).toLocaleString(),
        entry.user,
        personName(entry.user),
        (KINDS[kindOf(entry)] || { label: 'Other' }).label,
        describe(entry),
        (entry.added || []).join('; '),
        (entry.changed || []).map((c) => (c.fields && c.fields.length ? `${c.name} (${fieldsText(c.fields)})` : c.name)).join('; '),
        (entry.removed || []).join('; '),
        entry.ip || '',
      ]);
    });
    const text = `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
    const bytes = new TextEncoder().encode(text);
    const result = await shareFile('Server audit log', '', `certqr-audit-${state.month}.csv`, 'text/csv', bytes);
    showNote(result.outcome === 'failed' ? 'Couldn\'t make the file.' : '', result.outcome === 'failed');
  } catch (err) {
    showNote(err.message, true);
  } finally {
    exportBtn.disabled = false;
  }
});

// --- Start ---
async function start() {
  const config = loadServerConfig();
  const deny = (text) => {
    deniedText.textContent = text;
    deniedEl.classList.remove('hidden');
    bodyEl.classList.add('hidden');
  };
  if (!config) return deny('Sign in to a shared server as an admin to see its dashboard.');
  if (config.signedOut) return deny('Signed out. Sign in again.');
  // An admin may have been made one, or stopped being one, since signing in.
  try {
    await refreshServerAccount();
  } catch {
    // Offline: go by what's known.
  }
  if (!loadServerConfig().admin) return deny('Only an admin can see the server dashboard.');
  deniedEl.classList.add('hidden');
  bodyEl.classList.remove('hidden');
  try {
    (await listServerPeople()).forEach((person) => {
      names[person.id] = person.name;
    });
  } catch {
    names = {};
  }
  names['(on the Pi)'] = 'On the Pi (command line)';
  await load(false);
  return undefined;
}

start();
