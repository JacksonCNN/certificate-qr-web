// synclog.js — "Sync Log" page. What this phone has sent to the shared
// server, and what it still has waiting to go.
//
// Sent: history.js notes each change the server accepts (noteSyncSent),
// and photos.js each photo; this page reads that back, by day, each day
// folding away like the days of the Lab Log. Waiting: the collections
// with changes the server hasn't got yet (listUnsentServerChanges), and
// photos.js's queue of photos still to upload.
//
// The log is kept on this phone only. Clearing it clears the list, not
// anything that was sent.

const syncStatus = document.getElementById('sync-status');
const syncNowBtn = document.getElementById('sync-now');
const pendingList = document.getElementById('sync-pending-list');
const pendingCount = document.getElementById('sync-pending-count');
const syncLogList = document.getElementById('sync-log-list');
const syncLogCount = document.getElementById('sync-log-count');
const toggleAllBtn = document.getElementById('toggle-all-days');
const clearSyncLogBtn = document.getElementById('clear-sync-log');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const CHEVRON_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>';

// Which days are unfolded, and which lines have their names showing.
// The newest day opens by itself the first time it's seen.
const openDays = new Set();
const knownDays = new Set();
const openEntries = new Set();
let sending = false;

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// "2 new · 1 changed · 1 removed", "updated", "3 photos".
function changeSummary(entry) {
  const parts = [];
  if (entry.photos) parts.push(plural(entry.photos, 'photo'));
  if (entry.added && entry.added.length) parts.push(`${entry.added.length} new`);
  if (entry.changed && entry.changed.length) parts.push(`${entry.changed.length} changed`);
  if (entry.removed && entry.removed.length) parts.push(`${entry.removed.length} removed`);
  if (parts.length === 0 && entry.updated) parts.push('Updated');
  return parts.join(' · ');
}

function hasNames(entry) {
  return ['added', 'changed', 'removed'].some((field) => Array.isArray(entry[field]) && entry[field].length > 0);
}

function buildNames(entry) {
  const body = el('div', 'sync-entry-body');
  [['added', 'New'], ['changed', 'Changed'], ['removed', 'Removed']].forEach(([field, heading]) => {
    const names = Array.isArray(entry[field]) ? entry[field] : [];
    if (names.length === 0) return;
    body.appendChild(el('p', 'sync-entry-line', heading));
    const list = el('ul', 'sync-entry-items');
    names.forEach((name) => list.appendChild(el('li', null, name)));
    body.appendChild(list);
  });
  return body;
}

// One line: when (not for what's waiting), which part of the app, and what. Opens
// onto the names, when there are any.
function buildEntry(entry, openKey, timeText, waiting) {
  const wrap = el('div', 'sync-entry');
  const row = el('div', 'history-item lab-event');
  if (timeText) row.appendChild(el('span', 'lab-event-time', timeText));
  row.appendChild(el('span', `lab-badge sync-badge${waiting ? ' sync-badge-waiting' : ''}`, syncCollectionLabel(entry.key)));

  const named = hasNames(entry);
  const open = named && openEntries.has(openKey);
  const info = el(named ? 'button' : 'div', 'history-item-info sync-entry-toggle');
  info.appendChild(el('span', 'history-item-id', changeSummary(entry) || 'Changes'));
  if (named) {
    info.type = 'button';
    info.title = open ? 'Hide the names' : 'Show the names';
    info.setAttribute('aria-expanded', String(open));
    const first = [...(entry.added || []), ...(entry.changed || []), ...(entry.removed || [])];
    info.appendChild(el('span', 'history-item-meta', first.length > 2 ? `${first.slice(0, 2).join(', ')} and ${first.length - 2} more` : first.join(', ')));
    info.addEventListener('click', () => {
      if (openEntries.has(openKey)) openEntries.delete(openKey);
      else openEntries.add(openKey);
      renderAll();
    });
  }
  row.appendChild(info);
  wrap.appendChild(row);
  if (open) wrap.appendChild(buildNames(entry));
  return wrap;
}

// --- The server ---
function renderStatus() {
  const config = loadServerConfig();
  syncStatus.innerHTML = '';
  syncNowBtn.classList.toggle('hidden', !config);
  if (!config) {
    syncStatus.appendChild(document.createTextNode('This phone is not signed in to a shared server, so nothing is sent. '));
    const link = el('a', null, 'Sign in');
    link.href = 'login.html';
    syncStatus.appendChild(link);
    return;
  }
  const status = getServerStatus();
  let host = config.url;
  try {
    host = new URL(config.url).host;
  } catch {
    // Shown as it was entered.
  }
  const STATES = {
    online: 'Connected',
    offline: 'No connection — changes wait here and go once it is back',
    'signed-out': 'Signed out — sign in again',
    error: status.message || 'The server refused the last change',
  };
  const state = config.signedOut ? 'signed-out' : status.state;
  syncStatus.appendChild(el('span', `sync-status-state sync-status-state-${state}`, STATES[state] || 'Connected'));
  const who = config.userName || config.userId;
  syncStatus.appendChild(document.createTextNode(` · ${who ? `${who} on ` : ''}${host}`));
  const last = loadSyncLog()[0];
  if (last) syncStatus.appendChild(document.createTextNode(` · last sent ${formatSavedAt(last.at)}`));
  syncNowBtn.disabled = sending || state === 'signed-out';
  syncNowBtn.textContent = sending ? 'Sending…' : 'Send now';
}

// --- Waiting to send ---
let pendingRender = 0;

async function renderPending() {
  const ticket = ++pendingRender;
  const config = loadServerConfig();
  const waiting = config ? await listUnsentServerChanges() : [];
  const photos = config && typeof pendingPhotoUploads === 'function' ? pendingPhotoUploads().length : 0;
  if (photos) waiting.push({ key: 'photos', photos, added: [], changed: [], removed: [] });
  // A newer render started while this one was reading: that one wins.
  if (ticket !== pendingRender) return;

  pendingList.innerHTML = '';
  pendingCount.textContent = waiting.length > 0 ? `(${waiting.length})` : '';
  if (!config) {
    pendingList.appendChild(el('p', 'history-empty', 'Not signed in — everything stays on this phone.'));
    return;
  }
  if (waiting.length === 0) {
    pendingList.appendChild(el('p', 'history-empty', 'Nothing waiting. Everything on this phone has reached the server.'));
    return;
  }
  waiting.forEach((entry) => pendingList.appendChild(buildEntry(entry, `waiting:${entry.key}`, '', true)));
}

// --- Sent ---
function buildDayGroups(entries) {
  const groups = new Map();
  entries.forEach((entry) => {
    const key = dayKey(entry.at);
    if (!groups.has(key)) groups.set(key, { key, label: formatDay(entry.at), entries: [] });
    groups.get(key).entries.push(entry);
  });
  return Array.from(groups.values()).sort((a, b) => b.key.localeCompare(a.key));
}

function renderLog() {
  const entries = loadSyncLog();
  const groups = buildDayGroups(entries);
  syncLogCount.textContent = entries.length > 0 ? `(${entries.length})` : '';
  syncLogList.innerHTML = '';

  groups.forEach((group, index) => {
    if (knownDays.has(group.key)) return;
    knownDays.add(group.key);
    if (index === 0) openDays.add(group.key);
  });
  const allOpen = groups.length > 0 && groups.every((group) => openDays.has(group.key));
  toggleAllBtn.textContent = allOpen ? 'Collapse all' : 'Expand all';
  toggleAllBtn.classList.toggle('hidden', groups.length === 0);
  clearSyncLogBtn.classList.toggle('hidden', groups.length === 0);

  if (groups.length === 0) {
    syncLogList.appendChild(el('p', 'history-empty', 'Nothing sent from this phone yet.'));
    return;
  }

  groups.forEach((group) => {
    const open = openDays.has(group.key);
    const day = el('div', 'lab-day');
    const header = el('div', 'lab-day-header');
    const heading = el('h3', 'day-heading');
    const toggle = el('button', 'day-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.innerHTML = CHEVRON_ICON;
    toggle.appendChild(el('span', 'day-toggle-label', group.label));
    toggle.appendChild(el('span', 'day-toggle-summary', `${group.entries.length} sent`));
    toggle.addEventListener('click', () => {
      if (openDays.has(group.key)) openDays.delete(group.key);
      else openDays.add(group.key);
      renderLog();
    });
    heading.appendChild(toggle);
    header.appendChild(heading);
    day.appendChild(header);
    if (open) group.entries.forEach((entry) => day.appendChild(buildEntry(entry, entry.id, formatTime(entry.at), false)));
    syncLogList.appendChild(day);
  });
}

function renderAll() {
  renderStatus();
  renderPending();
  renderLog();
}

toggleAllBtn.addEventListener('click', () => {
  const groups = buildDayGroups(loadSyncLog());
  const allOpen = groups.every((group) => openDays.has(group.key));
  groups.forEach((group) => {
    if (allOpen) openDays.delete(group.key);
    else openDays.add(group.key);
  });
  renderLog();
});

clearSyncLogBtn.addEventListener('click', () => {
  if (loadSyncLog().length === 0) return;
  if (!window.confirm('Clear the list of what was sent? Nothing on the server is changed.')) return;
  saveSyncLog([]);
  renderAll();
});

syncNowBtn.addEventListener('click', async () => {
  if (sending) return;
  sending = true;
  renderStatus();
  try {
    await flushServerQueue();
    if (typeof uploadPendingPhotos === 'function') await uploadPendingPhotos();
  } finally {
    sending = false;
    renderAll();
  }
});

window.addEventListener('certqr:server-status', () => {
  renderStatus();
  renderPending();
});
window.addEventListener('certqr:sync-log', () => {
  renderStatus();
  renderPending();
  renderLog();
});

renderAll();
