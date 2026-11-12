// sharelog.js — "Shared Log" page. A list of what has been sent out of
// the app: PDFs of saved worksheets (database.js) and the in/out log as
// text (lablog.js). Those pages write an entry each time something is
// shared (history.js's addShareLogEntry); this page only reads them
// back, grouped by the day they were shared, each day folding away like
// the days of the Lab Log.
//
// It's a record of what went out, not a copy of it: a worksheet entry
// names the worksheets and the file, a lab log entry keeps the text
// that was sent. Deleting an entry here removes the note that something
// was shared — it can't unsend it.

const shareLogList = document.getElementById('share-log-list');
const shareLogCount = document.getElementById('share-log-count');
const toggleAllBtn = document.getElementById('toggle-all-days');
const clearShareLogBtn = document.getElementById('clear-share-log');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const DELETE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/><line x1="10" y1="11" x2="10" y2="16"/><line x1="14" y1="11" x2="14" y2="16"/></svg>';
const CHEVRON_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>';

const KIND_LABELS = { worksheets: 'Worksheets', lablog: 'Lab log' };

// Which days are unfolded, and which entries have their contents
// showing. The newest day opens by itself the first time it's seen;
// every other day starts folded, and from then on each stays as it was
// left.
const openDays = new Set();
const knownDays = new Set();
const openEntries = new Set();

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// How it went out, in words: "Shared to WhatsApp", "Copied to the
// clipboard", "Saved as a file".
function outcomeText(entry) {
  if (entry.outcome === 'copied') return 'Copied to the clipboard';
  if (entry.outcome === 'downloaded') return 'Saved as a file';
  return entry.via ? `Shared to ${entry.via}` : 'Shared';
}

function entryMeta(entry) {
  const parts = [outcomeText(entry)];
  if (entry.kind === 'worksheets') {
    const items = Array.isArray(entry.items) ? entry.items : [];
    if (items.length > 1) parts.push(plural(items.length, 'worksheet'));
    if (entry.pages) parts.push(plural(entry.pages, 'page'));
    if (entry.photos) parts.push(plural(entry.photos, 'photo'));
  }
  return parts.join(' · ');
}

// What was in it: the worksheets by name for a PDF, the text itself for
// a lab log.
function buildEntryContents(entry) {
  const body = el('div', 'share-entry-body');
  if (entry.kind === 'worksheets') {
    if (entry.customer) body.appendChild(el('p', 'share-entry-line', `Customer: ${entry.customer}`));
    if (entry.fileName) body.appendChild(el('p', 'share-entry-line', `File: ${entry.fileName}`));
    const items = Array.isArray(entry.items) ? entry.items : [];
    const list = el('ol', 'share-entry-items');
    items.forEach((item) => {
      const saved = formatSavedAt(item.savedAt);
      list.appendChild(el('li', null, saved ? `${item.label} — saved ${saved}` : item.label));
    });
    body.appendChild(list);
  } else if (entry.text) {
    body.appendChild(el('pre', 'share-entry-text', entry.text));
  } else {
    body.appendChild(el('p', 'share-entry-line', 'Nothing more was recorded about this one.'));
  }
  return body;
}

function buildEntry(entry) {
  const wrap = el('div', 'share-entry');
  const row = el('div', 'history-item lab-event');
  row.appendChild(el('span', 'lab-event-time', formatTime(entry.at)));
  row.appendChild(el('span', `lab-badge share-badge share-badge-${entry.kind}`, KIND_LABELS[entry.kind] || 'Shared'));

  const open = openEntries.has(entry.id);
  const info = el('button', 'history-item-info share-entry-toggle');
  info.type = 'button';
  info.title = open ? 'Hide what was shared' : 'Show what was shared';
  info.setAttribute('aria-expanded', String(open));
  info.appendChild(el('span', 'history-item-id', entry.title || 'Shared'));
  info.appendChild(el('span', 'history-item-meta', entryMeta(entry)));
  info.addEventListener('click', () => {
    if (openEntries.has(entry.id)) openEntries.delete(entry.id);
    else openEntries.add(entry.id);
    render();
  });
  row.appendChild(info);

  const actions = el('div', 'history-item-actions');
  const deleteBtn = el('button', 'history-item-btn history-item-btn-danger');
  deleteBtn.type = 'button';
  deleteBtn.title = 'Remove from the log';
  deleteBtn.setAttribute('aria-label', 'Remove from the log');
  deleteBtn.innerHTML = DELETE_ICON;
  deleteBtn.addEventListener('click', () => {
    saveShareLogEntries(loadShareLog().filter((e) => e.id !== entry.id));
    render();
  });
  actions.appendChild(deleteBtn);
  row.appendChild(actions);

  wrap.appendChild(row);
  if (open) wrap.appendChild(buildEntryContents(entry));
  return wrap;
}

// Entries by the day they were shared on, newest day first; within a
// day, newest first too — the log is kept that way.
function buildDayGroups(entries) {
  const groups = new Map();
  entries.forEach((entry) => {
    const key = dayKey(entry.at);
    if (!groups.has(key)) groups.set(key, { key, label: formatDay(entry.at), entries: [] });
    groups.get(key).entries.push(entry);
  });
  return Array.from(groups.values()).sort((a, b) => b.key.localeCompare(a.key));
}

function render() {
  const entries = loadShareLog();
  const groups = buildDayGroups(entries);
  shareLogCount.textContent = entries.length > 0 ? `(${entries.length})` : '';
  shareLogList.innerHTML = '';

  groups.forEach((group, index) => {
    if (knownDays.has(group.key)) return;
    knownDays.add(group.key);
    if (index === 0) openDays.add(group.key);
  });
  const allOpen = groups.length > 0 && groups.every((group) => openDays.has(group.key));
  toggleAllBtn.textContent = allOpen ? 'Collapse all' : 'Expand all';
  toggleAllBtn.classList.toggle('hidden', groups.length === 0);

  if (groups.length === 0) {
    shareLogList.appendChild(el('p', 'history-empty', 'Nothing has been shared yet — worksheets shared from the Records page and logs shared from the Lab Log page are listed here.'));
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
    toggle.appendChild(el('span', 'day-toggle-summary', `${group.entries.length} shared`));
    toggle.addEventListener('click', () => {
      if (openDays.has(group.key)) openDays.delete(group.key);
      else openDays.add(group.key);
      render();
    });
    heading.appendChild(toggle);
    header.appendChild(heading);
    day.appendChild(header);
    if (open) group.entries.forEach((entry) => day.appendChild(buildEntry(entry)));
    shareLogList.appendChild(day);
  });
}

toggleAllBtn.addEventListener('click', () => {
  const groups = buildDayGroups(loadShareLog());
  const allOpen = groups.every((group) => openDays.has(group.key));
  groups.forEach((group) => {
    if (allOpen) openDays.delete(group.key);
    else openDays.add(group.key);
  });
  render();
});

clearShareLogBtn.addEventListener('click', () => {
  if (loadShareLog().length === 0) return;
  if (!window.confirm('Clear the whole shared log? This only removes the list of what was shared — nothing that was sent is taken back.')) return;
  saveShareLogEntries([]);
  render();
});

hydrateStorage([SHARE_LOG_KEY]).then(render);
