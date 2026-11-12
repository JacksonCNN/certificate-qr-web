// app.js — "Scans" page (scans.html). Pure history browser: every certificate ever
// decoded (on the Worksheet page, where the scanner actually lives) is
// upserted into the shared history (history.js's storage) the moment
// it's scanned, and this page just lists/reopens/downloads/deletes
// those entries. It has no scanner or decoder of its own.
//
// Payload shape (from equipment-tracker's exportQrCertificates.js):
//   { id, name, cert, trace, due, tables: [{ scope, unit, rows: [[labRdg, correction, uncertainty], ...] }] }
// `name` (equipment description) is only present on QRs from exporter
// revisions that added it — older/blank values render as "—".

const resultPanel = document.getElementById('result-panel');
const resultBody = document.getElementById('result-body');
const useInWorksheetBtn = document.getElementById('use-in-worksheet');
const saveDataBtn = document.getElementById('save-data');
const historyList = document.getElementById('history-list');
const historyCount = document.getElementById('history-count');
const clearHistoryBtn = document.getElementById('clear-history');
const historySearch = document.getElementById('history-search');

// The payload currently shown in the result panel — what "Download
// .json" and "Use in a worksheet" act on. Set by renderPayload, read by
// those buttons' own click handlers below.
let currentPayload = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const DOWNLOAD_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>';
const DELETE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/><line x1="10" y1="11" x2="10" y2="16"/><line x1="14" y1="11" x2="14" y2="16"/></svg>';

// Mirrors equipment-tracker's own Danger/Aware/Safe day thresholds
// (computeEquipmentPriority.js's DEFAULT_PRIORITY_THRESHOLDS: 30/60
// days) — this decoder is a standalone tool with no access to that
// app's admin-configurable thresholds, so it uses the same defaults
// rather than inventing its own scale. Returns null when there's no
// usable due date to judge (blank, or not a parseable date).
function computeDueStatus(dueDateStr) {
  if (!dueDateStr) return null;
  const dueDate = new Date(dueDateStr);
  if (Number.isNaN(dueDate.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysUntil = Math.floor((dueDate - today) / (1000 * 60 * 60 * 24));
  if (daysUntil < 0) {
    const overdueDays = Math.abs(daysUntil);
    return { level: 'overdue', icon: '⚠', text: `Overdue by ${overdueDays} day${overdueDays === 1 ? '' : 's'} — recalibration required` };
  }
  if (daysUntil < 30) return { level: 'danger', icon: '⚠', text: `Due in ${daysUntil} day${daysUntil === 1 ? '' : 's'}` };
  if (daysUntil < 60) return { level: 'aware', icon: '●', text: `Due in ${daysUntil} days` };
  return { level: 'safe', icon: '✓', text: `Valid — due in ${daysUntil} days` };
}

function buildRawBlock(rawText) {
  const wrap = document.createElement('div');
  const toggle = el('button', 'raw-toggle', 'Show raw QR text');
  const pre = el('pre', 'raw-json', rawText);
  pre.hidden = true;
  toggle.addEventListener('click', () => {
    pre.hidden = !pre.hidden;
    toggle.textContent = pre.hidden ? 'Show raw QR text' : 'Hide raw QR text';
  });
  wrap.appendChild(toggle);
  wrap.appendChild(pre);
  return wrap;
}

function renderPayload(payload, rawText) {
  resultPanel.classList.remove('hidden');
  resultBody.innerHTML = '';
  currentPayload = payload;

  const dueStatus = computeDueStatus(payload.due);
  if (dueStatus) {
    const banner = el('div', `due-banner due-banner-${dueStatus.level}`);
    banner.appendChild(el('span', 'due-banner-icon', dueStatus.icon));
    banner.appendChild(el('span', null, dueStatus.text));
    resultBody.appendChild(banner);
  }

  const summary = el('div', 'summary-grid');
  const fields = [
    ['Equipment ID', payload.id],
    ['Equipment Description', payload.name],
    ['Latest Cal Cert no.', payload.cert],
    ['Traceability', payload.trace],
    ['Ext. Cal. Due date', payload.due],
  ];
  fields.forEach(([label, value]) => {
    const item = el('div', 'summary-item');
    item.appendChild(el('span', 'summary-label', label));
    item.appendChild(el('span', 'summary-value', value || '—'));
    summary.appendChild(item);
  });
  resultBody.appendChild(summary);

  const tables = Array.isArray(payload.tables) ? payload.tables : [];
  if (tables.length === 0) {
    resultBody.appendChild(el('p', null, 'No Certificate data tables in this QR code.'));
  }
  tables.forEach((table) => {
    const block = el('div', 'table-block');
    const scopeUnit = [table.scope, table.unit].filter(Boolean).join(' · ');
    // On a label with several certificates, which of them the table is from.
    const from = scanCertificates(payload).length > 1 && table.cert ? ` — ${table.cert}` : '';
    block.appendChild(el('h3', null, `${scopeUnit || 'Table'}${from}`));

    const rows = Array.isArray(table.rows) ? table.rows : [];
    const tableEl = document.createElement('table');
    tableEl.className = 'data-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['Lab Rdg', 'Correction', 'Uncertainty'].forEach((h) => headRow.appendChild(el('th', null, h)));
    thead.appendChild(headRow);
    tableEl.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      [0, 1, 2].forEach((i) => tr.appendChild(el('td', null, row[i] !== undefined && row[i] !== '' ? row[i] : '—')));
      tbody.appendChild(tr);
    });
    tableEl.appendChild(tbody);
    block.appendChild(tableEl);
    resultBody.appendChild(block);
  });

  resultBody.appendChild(buildRawBlock(rawText));
}

useInWorksheetBtn.addEventListener('click', () => {
  if (!currentPayload) return;
  // Kept for the worksheets already made with it, not for new ones —
  // once none of its certificates is within its due date any more.
  if (!hasValidCertificate(currentPayload)) {
    window.alert(dueEquipmentMessage(currentPayload, 'used in a new worksheet'));
    return;
  }
  setPendingWorksheetEquip({ equipmentId: currentPayload.id, equipmentCert: currentPayload.cert });
  window.location.href = 'interpolate.html';
});

saveDataBtn.addEventListener('click', () => {
  if (!currentPayload) return;
  downloadJson(`${safeFilenamePart(currentPayload.id)}_${safeFilenamePart(currentPayload.cert)}.json`, currentPayload);
});

function renderHistoryList() {
  const allEntries = loadHistory();
  const query = historySearch.value.trim().toLowerCase();
  const entries = query
    ? allEntries.filter((e) => [e.id, e.name, e.cert, e.trace].filter(Boolean).join(' ').toLowerCase().includes(query))
    : allEntries;
  historyCount.textContent = query ? `(${entries.length} of ${allEntries.length})` : entries.length > 0 ? `(${entries.length})` : '';
  historyList.innerHTML = '';

  if (entries.length === 0 && query) {
    historyList.appendChild(el('p', 'history-empty', `No scans match "${historySearch.value.trim()}".`));
    return;
  }
  if (entries.length === 0) {
    historyList.appendChild(el('p', 'history-empty', 'No certificates scanned yet — scan one from the Worksheet page and it\'ll show up here.'));
    return;
  }

  entries.forEach((entry) => {
    const row = el('div', 'history-item');

    const info = el('button', 'history-item-info');
    info.type = 'button';
    info.title = 'View this scan';
    const idSpan = el('span', 'history-item-id', entry.name ? `${entry.id || '(no ID)'} — ${entry.name}` : (entry.id || '(no ID)'));
    const metaSpan = el('span', 'history-item-meta', `${entry.cert || '—'} · saved ${formatSavedAt(entry.savedAt)}`);
    info.appendChild(idSpan);
    // Past its due date: still here, marked, and not for new work.
    if (isCalibrationDue(entry.due)) info.appendChild(el('span', 'scan-due-flag', `Calibration due ${entry.due}`));
    // Still good, but not for long — time to book the recalibration.
    else if (isDueSoon(entry.due)) info.appendChild(el('span', 'scan-due-flag scan-due-soon', `Calibration ${dueSoonText(entry.due)}`));
    info.appendChild(metaSpan);
    info.addEventListener('click', () => {
      renderPayload(entry, JSON.stringify(entry, null, 2));
      resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    row.appendChild(info);

    const actions = el('div', 'history-item-actions');
    const downloadBtn = el('button', 'history-item-btn');
    downloadBtn.type = 'button';
    downloadBtn.title = 'Download .json';
    downloadBtn.setAttribute('aria-label', 'Download .json');
    downloadBtn.innerHTML = DOWNLOAD_ICON;
    downloadBtn.addEventListener('click', () => downloadJson(`${safeFilenamePart(entry.id)}_${safeFilenamePart(entry.cert)}.json`, entry));
    const deleteBtn = el('button', 'history-item-btn history-item-btn-danger');
    deleteBtn.type = 'button';
    deleteBtn.title = 'Delete scan';
    deleteBtn.setAttribute('aria-label', 'Delete scan');
    deleteBtn.innerHTML = DELETE_ICON;
    deleteBtn.addEventListener('click', () => {
      if (currentPayload === entry) {
        resultPanel.classList.add('hidden');
        currentPayload = null;
      }
      // Its place in the whole list, not in what the search is showing.
      removeFromHistory(allEntries.indexOf(entry));
      renderHistoryList();
    });
    actions.appendChild(downloadBtn);
    actions.appendChild(deleteBtn);
    row.appendChild(actions);

    historyList.appendChild(row);
  });
}

clearHistoryBtn.addEventListener('click', () => {
  if (!window.confirm('Remove all saved scans from this device? This does not affect any .json files already downloaded.')) return;
  clearHistory();
  resultPanel.classList.add('hidden');
  currentPayload = null;
  renderHistoryList();
});

historySearch.addEventListener('input', renderHistoryList);

hydrateStorage([HISTORY_KEY]).then(renderHistoryList);
