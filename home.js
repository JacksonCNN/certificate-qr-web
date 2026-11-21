// home.js — the page the app opens on (index.html). Nothing is entered
// here; it's the state of things at a glance, each part leading to the
// page that deals with it:
//   - what is out of the lab now, and what's been out too long;
//   - which equipment's calibration is due, or will be within the month;
//   - the worksheets saved most recently;
//   - a nudge when it's been a while since the last backup.
// All of it is read from what the other pages keep (history.js).

const homeBackup = document.getElementById('home-backup');
const homeOutList = document.getElementById('home-out-list');
const homeOutCount = document.getElementById('home-out-count');
const homeDueList = document.getElementById('home-due-list');
const homeDueCount = document.getElementById('home-due-count');
const homeRecentList = document.getElementById('home-recent-list');

// How many of each list the page shows before it says "and N more".
const HOME_LIST_LIMIT = 5;
// A backup older than this is worth mentioning.
const BACKUP_REMINDER_DAYS = 14;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function equipmentLabel(id, name) {
  return name ? `${id} — ${name}` : id;
}

// One line of a list: what it is, a line about it, and any flags.
function buildRow(title, meta, flags) {
  const row = el('div', 'history-item home-item');
  const info = el('div', 'lab-item-info');
  const heading = el('span', 'history-item-id', title);
  flags.forEach((flag) => heading.appendChild(el('span', `item-flag item-flag-${flag.level}`, flag.text)));
  info.appendChild(heading);
  info.appendChild(el('span', 'history-item-meta', meta));
  row.appendChild(info);
  return row;
}

function fillList(listEl, rows, emptyText, moreHref) {
  listEl.innerHTML = '';
  if (rows.length === 0) {
    listEl.appendChild(el('p', 'history-empty', emptyText));
    return;
  }
  rows.slice(0, HOME_LIST_LIMIT).forEach((row) => listEl.appendChild(row));
  if (rows.length > HOME_LIST_LIMIT) {
    const more = el('a', 'home-more', `and ${rows.length - HOME_LIST_LIMIT} more`);
    more.href = moreHref;
    listEl.appendChild(more);
  }
}

// --- Out of the lab ---
// Longest out first: that's the one to chase.
function renderOut() {
  const { outTooLongDays } = loadSettings();
  const history = loadHistory();
  const out = loadLabLog().filter((entry) => !entry.inAt).sort((a, b) => new Date(a.outAt) - new Date(b.outAt));
  homeOutCount.textContent = out.length > 0 ? `(${out.length})` : '';
  const rows = out.map((entry) => {
    const flags = [];
    const days = daysOutOfLab(entry);
    if (days > outTooLongDays) flags.push({ level: 'err', text: `Out ${days} days` });
    const scan = history.find((h) => h.id && h.id.toLowerCase() === String(entry.equipmentId).toLowerCase());
    if (scan && isCalibrationDue(scan.due)) flags.push({ level: 'err', text: 'Calibration due' });
    else if (scan && isDueSoon(scan.due)) flags.push({ level: 'warn', text: `Cal. ${dueSoonText(scan.due)}` });
    const who = [entry.takenBy, entry.note].filter(Boolean).join(' · ');
    return buildRow(equipmentLabel(entry.equipmentId, entry.equipmentName), `Out since ${formatDay(entry.outAt)}, ${formatTime(entry.outAt)}${who ? ` · ${who}` : ''}`, flags);
  });
  fillList(homeOutList, rows, 'Everything is in the lab.', 'lablog.html');
}

// --- Calibration due ---
// Going by the latest certificate scanned for each piece of equipment:
// the ones already past their date, then the ones within the month,
// soonest first.
function renderDue() {
  const seen = new Set();
  const due = [];
  loadHistory().forEach((scan) => {
    if (!scan.id || seen.has(scan.id)) return;
    seen.add(scan.id);
    const days = daysUntilDue(scan.due);
    if (days !== null && days <= DUE_SOON_DAYS) due.push({ scan, days });
  });
  due.sort((a, b) => a.days - b.days);
  homeDueCount.textContent = due.length > 0 ? `(${due.length})` : '';
  const rows = due.map(({ scan, days }) => {
    const flag = days < 0
      ? { level: 'err', text: `Overdue ${-days} day${days === -1 ? '' : 's'}` }
      : { level: 'warn', text: dueSoonText(scan.due) };
    return buildRow(equipmentLabel(scan.id, scan.name), `${scan.cert || '—'} · due ${scan.due}`, [flag]);
  });
  fillList(homeDueList, rows, `Nothing is due within ${DUE_SOON_DAYS} days.`, 'scans.html');
}

// --- Recent worksheets ---
// Each one opens on the Records page.
function renderRecent() {
  const customers = loadCustomers();
  const records = loadUutDatabase().slice().sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  homeRecentList.innerHTML = '';
  if (records.length === 0) {
    homeRecentList.appendChild(el('p', 'history-empty', 'No worksheets saved yet.'));
    return;
  }
  records.slice(0, HOME_LIST_LIMIT).forEach((record) => {
    const link = el('a', 'history-item home-item home-link');
    link.href = `database.html#${encodeURIComponent(record.id || '')}`;
    const info = el('div', 'lab-item-info');
    const heading = el('span', 'history-item-id', formatUutLabel(record.uutModel, record.uutSerial) || '(unnamed)');
    const result = recordResult(record);
    if (result) heading.appendChild(el('span', `record-result record-result-${result}`, RESULT_LABELS[result]));
    info.appendChild(heading);
    const customer = customers.find((c) => c.id === record.customerId);
    const filedUnder = customer ? customer.name : record.customerName;
    info.appendChild(el('span', 'history-item-meta', [filedUnder, `saved ${formatSavedAt(record.savedAt)}`].filter(Boolean).join(' · ')));
    link.appendChild(info);
    homeRecentList.appendChild(link);
  });
  if (records.length > HOME_LIST_LIMIT) {
    const more = el('a', 'home-more', `and ${records.length - HOME_LIST_LIMIT} more`);
    more.href = 'database.html';
    homeRecentList.appendChild(more);
  }
}

// --- Backup reminder ---
// Only once there's something to lose.
function renderBackupReminder() {
  const hasData = loadUutDatabase().length > 0 || loadLabLog().length > 0 || loadHistory().length > 0;
  const last = lastBackupAt();
  const days = last ? Math.floor((Date.now() - new Date(last).getTime()) / (1000 * 60 * 60 * 24)) : null;
  if (!hasData || (days !== null && days < BACKUP_REMINDER_DAYS)) {
    homeBackup.classList.add('hidden');
    return;
  }
  homeBackup.innerHTML = '';
  homeBackup.appendChild(el('span', 'due-banner-icon', '●'));
  const text = el('span', null, days === null ? 'This phone\'s data has never been backed up. ' : `Last backup was ${days} days ago. `);
  const link = el('a', null, 'Back up in Settings');
  link.href = 'settings.html';
  link.style.color = 'inherit';
  text.appendChild(link);
  homeBackup.appendChild(text);
  homeBackup.classList.remove('hidden');
}

hydrateStorage([HISTORY_KEY, UUT_DATABASE_KEY, LAB_LOG_KEY, CUSTOMERS_KEY, SETTINGS_KEY]).then(() => {
  ensureRecordIds();
  renderBackupReminder();
  renderOut();
  renderDue();
  renderRecent();
});
