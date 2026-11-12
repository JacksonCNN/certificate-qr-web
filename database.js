// database.js — "Records" page. Browses the UUT records saved from the
// Worksheet page's Save button (interpolate.js, history.js's
// UUT_DATABASE_KEY), one customer folder at a time. Each record is a
// frozen snapshot taken at Save time, not a live view of a worksheet —
// editing or deleting a tab on the Worksheet page never changes what's
// shown here.

const dbList = document.getElementById('db-list');
const dbCount = document.getElementById('db-count');
const dbNote = document.getElementById('db-note');
const clearDbBtn = document.getElementById('clear-db');
const shareSelectedBtn = document.getElementById('share-selected');
const dbSearch = document.getElementById('db-search');
const detailEditBtn = document.getElementById('detail-edit');
const detailPanel = document.getElementById('detail-panel');
const detailTitle = document.getElementById('detail-title');
const detailBody = document.getElementById('detail-body');
const detailShareBtn = document.getElementById('detail-share');
const detailCloseBtn = document.getElementById('detail-close');
const sortFieldSelect = document.getElementById('db-sort-field');
const sortDirBtn = document.getElementById('db-sort-dir');

let currentRecord = null;
// The records ticked for sharing together — the record objects
// themselves, as loadUutDatabase() hands them out; a record deleted while
// ticked is weeded out when the list is next drawn.
const selectedRecords = new Set();
let sortField = 'date'; // 'date' | 'name'
let sortDir = 'desc'; // 'asc' | 'desc' — desc matches the previous (unsorted) default of newest-first

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function cellText(value) {
  return value ? String(value) : '—';
}

const SHARE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.7" x2="15.4" y2="6.3"/><line x1="8.6" y1="13.3" x2="15.4" y2="17.7"/></svg>';
const EDIT_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16Z"/><line x1="13" y1="7" x2="17" y2="11"/></svg>';
const DELETE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/><line x1="10" y1="11" x2="10" y2="16"/><line x1="14" y1="11" x2="14" y2="16"/></svg>';
const SORT_DESC_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="4" x2="12" y2="20"/><polyline points="6 14 12 20 18 14"/></svg>';
const SORT_ASC_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="4" x2="12" y2="20"/><polyline points="6 10 12 4 18 10"/></svg>';

function showNote(text, isError) {
  dbNote.textContent = text;
  dbNote.classList.toggle('hidden', !text);
  dbNote.classList.toggle('scan-status-error', Boolean(isError));
}

// --- Customer folders ---
// Which folder a record is listed under: the customer folder it was
// saved in, by that folder's current name. If the folder has since been
// deleted, the record still carries the name it had, and is listed
// under that. A record saved with no folder (every record from before
// folders existed) is unfiled.
function recordFolder(record, customers) {
  const customer = record.customerId ? customers.find((c) => c.id === record.customerId) : null;
  if (customer) return { key: customer.id, name: customer.name };
  if (record.customerName) return { key: `name:${record.customerName}`, name: record.customerName };
  return { key: '', name: UNFILED_LABEL };
}

// --- Sharing ---
// Records go out as one PDF (record-sheet.js): each record's details,
// its tables of readings as real tables with the photos of the readings
// under them, and its remarks. One record from its own Share button, or
// every ticked one together from "Share selected" — still as a single
// file. Only a few lines of text go with it, to say what it is, and
// what went out is noted in the shared log (history.js).
const UUT_FIELDS = [
  ['Tag No.', 'uutTag'],
  ['Maker', 'uutMaker'],
  ['Range', 'uutRange'],
  ['SR (Scale Resolution)', 'uutResolution'],
];
const REFERENCE_FIELDS = [
  ['Equipment ID', 'equipmentId'],
  ['Equipment Description', 'equipmentName'],
  ['Latest Cal Cert No.', 'equipmentCert'],
  ['Ext. Cal. Due Date', 'equipmentDue'],
  ['Traceability', 'equipmentTrace'],
];

// The job itself: when, by whom, in what conditions, and how it came
// out. Two of these are kept as bare numbers and one is worked out
// (history.js's recordResult), so they're shown through
// recordDisplayValues below rather than straight off the record.
const CALIBRATION_FIELDS = [
  ['Calibration date', 'calDate'],
  ['Technician', 'technician'],
  ['Ambient temperature', 'ambientTempText'],
  ['Humidity', 'ambientHumidityText'],
  ['Result', 'resultText'],
];

function recordDisplayValues(record) {
  return {
    ambientTempText: record.ambientTemp ? `${record.ambientTemp} °C` : '',
    ambientHumidityText: record.ambientHumidity ? `${record.ambientHumidity} %RH` : '',
    resultText: RESULT_LABELS[recordResult(record)] || '',
  };
}

// Hands the record to the Worksheet page to be worked on again
// (history.js's "Edit this record" handoff). Saving there writes over
// this record rather than adding another.
function editRecord(record) {
  setPendingWorksheetRecord(record.id);
  window.location.href = 'interpolate.html';
}

function recordLabel(record) {
  return formatUutLabel(record.uutModel, record.uutSerial) || '(unnamed)';
}

// One share at a time: building the document takes a moment, and a
// second press in that moment shouldn't start a second one.
let sharingRecords = false;

function recordSheetDetails(record) {
  const folder = recordFolder(record, loadCustomers());
  return {
    customer: folder.key ? folder.name : '',
    calibrationFields: CALIBRATION_FIELDS,
    uutFields: UUT_FIELDS,
    referenceFields: REFERENCE_FIELDS,
    values: recordDisplayValues(record),
    result: recordResult(record),
  };
}

// Shares `records` as one PDF. Resolves once the share sheet has been
// dealt with (or the file downloaded, where there is no share sheet).
async function shareRecords(records) {
  if (sharingRecords || records.length === 0) return;
  sharingRecords = true;
  const items = records.map((record) => ({ record, details: recordSheetDetails(record) }));
  // What they're filed under, if that's one thing for all of them.
  const customers = new Set(items.map((item) => item.details.customer));
  const customer = customers.size === 1 ? items[0].details.customer : '';
  const single = records.length === 1;
  const title = single ? `Worksheet — ${recordLabel(records[0])}` : `${records.length} worksheets${customer ? ` — ${customer}` : ''}`;
  const fileName = single
    ? `${photoNamePart(formatUutLabel(records[0].uutModel, records[0].uutSerial), 60) || 'Worksheet'}_Result.pdf`
    : `${photoNamePart(customer, 50) || 'Worksheets'}_${records.length}-worksheets.pdf`;
  const caption = single
    ? [title, customer && `Customer: ${customer}`, `Saved: ${formatSavedAt(records[0].savedAt)}`].filter(Boolean).join('\n')
    : [title, ...records.map((record, index) => `${index + 1}. ${recordLabel(record)}`)].join('\n');

  showNote(single ? 'Preparing the worksheet…' : `Preparing ${records.length} worksheets…`);
  try {
    const built = await buildRecordsPdf(items, title.replace('—', '-'), (done, total) => {
      if (total > 1) showNote(`Preparing ${total} worksheets… ${done} of ${total}`);
    });
    const result = await shareFile(title, caption, fileName, 'application/pdf', built.bytes);
    addShareLogEntry(result, {
      kind: 'worksheets',
      title,
      customer,
      fileName,
      pages: built.pageCount,
      photos: built.photoCount,
      items: records.map((record) => ({ label: recordLabel(record), savedAt: record.savedAt })),
    });
    const missing = built.missingPhotos > 0 ? ` ${built.missingPhotos} photo${built.missingPhotos === 1 ? '' : 's'} could not be found and ${built.missingPhotos === 1 ? 'is' : 'are'} not in it.` : '';
    if (result.outcome === 'failed') showNote('The file could not be prepared for sharing.', true);
    else if (result.outcome === 'downloaded') showNote(`Saved as ${fileName} — this browser can't share a file, so it was downloaded instead.${missing}`);
    else showNote(missing.trim(), Boolean(missing));
  } catch (err) {
    showNote(`The file could not be prepared for sharing: ${(err && err.message) || err}`, true);
  } finally {
    sharingRecords = false;
  }
}

function shareRecord(record) {
  return shareRecords([record]);
}

// A label/value list — same "info-dl" component interpolate.html's own
// Calibration info uses — so a saved record's reference data reads the
// same way the worksheet it came from did, and doesn't need a squeezed
// multi-column table or horizontal scroll on a phone.
function buildInfoTable(title, fields, record) {
  const block = el('div', 'table-block');
  block.appendChild(el('h3', null, title));
  const dl = el('dl', 'info-dl');
  fields.forEach(([label, key]) => {
    const row = el('div', 'info-dl-row');
    row.appendChild(el('dt', null, label));
    row.appendChild(el('dd', null, cellText(record[key])));
    dl.appendChild(row);
  });
  block.appendChild(dl);
  return block;
}

// A table saved in an official worksheet's layout (worksheet-forms.js):
// the record holds its headings and every cell as they read when it
// was saved, so it is drawn from those alone. A cell that was out of
// tolerance is red.
function buildFormRecord(form) {
  const wrap = el('div', 'interp-table-wrap');
  const tableEl = document.createElement('table');
  tableEl.className = 'data-table form-table form-record';
  const thead = document.createElement('thead');
  form.head.forEach((cells, index) => {
    const tr = el('tr', index === form.head.length - 1 ? 'form-units' : null);
    cells.forEach((cell) => {
      const th = el('th', null, cell.t);
      if (cell.c > 1) th.colSpan = cell.c;
      if (cell.r > 1) th.rowSpan = cell.r;
      tr.appendChild(th);
    });
    thead.appendChild(tr);
  });
  tableEl.appendChild(thead);
  const tbody = document.createElement('tbody');
  form.rows.forEach((cells, rowIndex) => {
    const tr = document.createElement('tr');
    const fails = (form.fails && form.fails[rowIndex]) || [];
    cells.forEach((text, index) => tr.appendChild(el('td', fails.includes(index) ? 'tol-fail' : null, cellText(text))));
    tbody.appendChild(tr);
  });
  tableEl.appendChild(tbody);
  wrap.appendChild(tableEl);
  return wrap;
}

function renderDetail(record) {
  currentRecord = record;
  detailPanel.classList.remove('hidden');
  detailBody.innerHTML = '';
  detailTitle.textContent = formatUutLabel(record.uutModel, record.uutSerial) || 'Record details';

  // Model/Serial are already in the title above, and the customer rides
  // along in this meta line; the rest of what describes the UUT gets the
  // table below.
  const folder = recordFolder(record, loadCustomers());
  const customerPrefix = folder.key ? `${folder.name} · ` : '';
  detailBody.appendChild(el('p', 'camera-note', `${customerPrefix}Saved ${formatSavedAt(record.savedAt)}`));

  // Which customer folder it's filed under — and the way to file it
  // under another. A folder that has since been deleted is listed too,
  // for as long as the record is still in it.
  const folderRow = el('div', 'entry-form-row record-folder-row');
  const folderLabel = el('label', null, 'Customer folder');
  const folderSelect = document.createElement('select');
  folderSelect.appendChild(el('option', null, UNFILED_LABEL)).value = '';
  const customers = loadCustomers().slice().sort((a, b) => a.name.localeCompare(b.name));
  customers.forEach((customer) => {
    folderSelect.appendChild(el('option', null, customer.name)).value = customer.id;
  });
  const inKnownFolder = customers.some((customer) => customer.id === record.customerId);
  if (!inKnownFolder && record.customerName) {
    folderSelect.appendChild(el('option', null, `${record.customerName} (folder deleted)`)).value = '__gone__';
    folderSelect.value = '__gone__';
  } else {
    folderSelect.value = inKnownFolder ? record.customerId : '';
  }
  folderSelect.addEventListener('change', () => {
    if (folderSelect.value === '__gone__') return;
    const target = customers.find((customer) => customer.id === folderSelect.value) || null;
    record.customerId = target ? target.id : null;
    record.customerName = target ? target.name : null;
    // The record object is the one in the list, so saving the list saves it.
    saveUutDatabaseEntries(loadUutDatabase());
    renderDbList();
    renderDetail(record);
  });
  folderLabel.appendChild(folderSelect);
  folderRow.appendChild(folderLabel);
  detailBody.appendChild(folderRow);

  const shown = { ...record, ...recordDisplayValues(record) };
  if (CALIBRATION_FIELDS.some(([, key]) => shown[key])) detailBody.appendChild(buildInfoTable('Calibration', CALIBRATION_FIELDS, shown));

  // Left out altogether for a record with none of these — every record
  // saved before the fields existed — rather than shown as four dashes.
  if (UUT_FIELDS.some(([, key]) => record[key])) detailBody.appendChild(buildInfoTable('UUT Info', UUT_FIELDS, record));

  detailBody.appendChild(buildInfoTable('Reference Info', REFERENCE_FIELDS, record));

  // One block per table of the worksheet (history.js's worksheetTables
  // reads a record from before there could be several as the one table
  // it was): what it was read against and whether that was before or
  // after adjustment, its readings, then the photos taken of them.
  const tables = worksheetTables(record);
  if (tables.length === 0) {
    detailBody.appendChild(el('p', null, 'No interpolation rows were entered when this record was saved.'));
  }
  tables.forEach((table, tableIndex) => {
    const block = el('div', 'table-block');
    const heading = el('h3', 'record-table-heading', [tables.length > 1 ? `Table ${tableIndex + 1}` : 'Readings', table.scopeUnitLabel].filter(Boolean).join(' — '));
    if (ADJUST_STAGES[table.stage]) heading.appendChild(el('span', `stage-chip stage-chip-${table.stage}`, ADJUST_STAGES[table.stage]));
    block.appendChild(heading);
    // Which official worksheet the table follows, and the function it
    // was for, where it has those.
    const formLine = table.form ? [table.form.name, table.fn && `Function: ${table.fn}`].filter(Boolean).join(' · ') : '';
    if (formLine) block.appendChild(el('p', 'record-table-accuracy', formLine));
    const certificate = tableCertificateLine(table, tables);
    if (certificate) block.appendChild(el('p', 'record-table-accuracy', certificate));
    // What the table's readings were judged against, if anything was
    // entered — each table of a worksheet can have its own.
    const accuracy = formatAccuracy(table);
    if (accuracy) block.appendChild(el('p', 'record-table-accuracy', `Accuracy: ${accuracy}`));

    if (table.form) {
      block.appendChild(buildFormRecord(table.form));
    } else {
      const tableEl = document.createElement('table');
      tableEl.className = 'data-table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      [table.labRdgHeader || 'Lab Rdg', 'Lab Correction Rdg', 'Act Lab Rdg', table.uutRdgHeader || 'UUT Rdg', 'Correction Rdg']
        .forEach((h) => headRow.appendChild(el('th', null, h)));
      thead.appendChild(headRow);
      tableEl.appendChild(thead);

      const tbody = document.createElement('tbody');
      table.rows.forEach((row) => {
        const tr = document.createElement('tr');
        // Out of tolerance when it was saved — the same red the worksheet
        // showed it in.
        if (row.outOfTolerance) tr.className = 'record-row-fail';
        [row.labRdg, row.labCorrectionRdg, row.actLabRdg, row.uutRdg, row.correctionRdg]
          .forEach((v) => tr.appendChild(el('td', null, cellText(v))));
        tbody.appendChild(tr);
      });
      tableEl.appendChild(tbody);
      block.appendChild(tableEl);
    }

    // View only here — a record is a snapshot, so photos are removed
    // with the record rather than one at a time.
    table.rows.forEach((row, index) => {
      const photoIds = rowPhotoIds([row]);
      if (photoIds.length === 0) return;
      const line = el('div', 'record-photo-row');
      line.appendChild(el('span', 'record-photo-label', `${String(index + 1).padStart(2, '0')} · ${table.labRdgHeader || 'Lab Rdg'} ${cellText(row.labRdg)}`));
      const strip = el('div', 'photo-strip');
      photoIds.forEach((photoId) => strip.appendChild(buildPhotoThumb(photoId)));
      line.appendChild(strip);
      block.appendChild(line);
    });
    detailBody.appendChild(block);
  });

  if (record.remarks) {
    const block = el('div', 'table-block');
    block.appendChild(el('h3', null, 'Remarks'));
    block.appendChild(el('p', 'record-remarks', record.remarks));
    detailBody.appendChild(block);
  }

  detailPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeDetail() {
  detailPanel.classList.add('hidden');
  currentRecord = null;
}

detailShareBtn.addEventListener('click', () => {
  if (currentRecord) shareRecord(currentRecord);
});

detailEditBtn.addEventListener('click', () => {
  if (currentRecord) editRecord(currentRecord);
});

detailCloseBtn.addEventListener('click', closeDetail);

// Sorted for display, but removeUutRecord() below needs an index into
// the underlying (unsorted) storage array — sortEntries returns the
// same record objects, just reordered, so entries[i]'s real storage
// index is found by identity (===) against rawEntries rather than
// trusted to equal its position in this sorted list.
function sortEntries(entries) {
  const sorted = entries.slice();
  sorted.sort((a, b) => {
    const cmp = sortField === 'name'
      ? (formatUutLabel(a.uutModel, a.uutSerial) || '').localeCompare(formatUutLabel(b.uutModel, b.uutSerial) || '')
      : new Date(a.savedAt).getTime() - new Date(b.savedAt).getTime();
    return sortDir === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

function updateSortDirBtn() {
  sortDirBtn.innerHTML = sortDir === 'asc' ? SORT_ASC_ICON : SORT_DESC_ICON;
  const label = sortDir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending';
  sortDirBtn.title = label;
  sortDirBtn.setAttribute('aria-label', label);
}

sortFieldSelect.addEventListener('change', () => {
  sortField = sortFieldSelect.value;
  renderDbList();
});

sortDirBtn.addEventListener('click', () => {
  sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  updateSortDirBtn();
  renderDbList();
});

// A tick box, with the label only a screen reader gets.
function buildTickBox(label, onChange) {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'record-tick';
  box.setAttribute('aria-label', label);
  box.addEventListener('change', () => onChange(box.checked));
  return box;
}

function updateShareSelectedBtn() {
  shareSelectedBtn.disabled = selectedRecords.size === 0;
  shareSelectedBtn.textContent = selectedRecords.size > 0 ? `Share selected (${selectedRecords.size})` : 'Share selected';
}

function buildRecordRow(entry, rawEntries) {
  const row = el('div', 'history-item');

  const tick = buildTickBox(`Select ${recordLabel(entry)} for sharing`, (checked) => {
    if (checked) selectedRecords.add(entry);
    else selectedRecords.delete(entry);
    // Redrawn so the folder's own tick box follows.
    renderDbList();
  });
  tick.checked = selectedRecords.has(entry);
  row.appendChild(tick);

  const info = el('button', 'history-item-info');
  info.type = 'button';
  info.title = 'View this record';
  const idSpan = el('span', 'history-item-id', recordLabel(entry));
  const result = recordResult(entry);
  if (result) idSpan.appendChild(el('span', `record-result record-result-${result}`, RESULT_LABELS[result]));
  const metaSpan = el('span', 'history-item-meta', `${entry.equipmentId || '—'} · ${entry.equipmentCert || '—'} · saved ${formatSavedAt(entry.savedAt)}`);
  info.appendChild(idSpan);
  info.appendChild(metaSpan);
  info.addEventListener('click', () => renderDetail(entry));
  row.appendChild(info);

  const actions = el('div', 'history-item-actions');
  const shareBtn = el('button', 'history-item-btn');
  shareBtn.type = 'button';
  shareBtn.title = 'Share worksheet';
  shareBtn.setAttribute('aria-label', 'Share worksheet');
  shareBtn.innerHTML = SHARE_ICON;
  shareBtn.addEventListener('click', () => shareRecord(entry));
  const editBtn = el('button', 'history-item-btn');
  editBtn.type = 'button';
  editBtn.title = 'Edit in the Worksheet page';
  editBtn.setAttribute('aria-label', 'Edit in the Worksheet page');
  editBtn.innerHTML = EDIT_ICON;
  editBtn.addEventListener('click', () => editRecord(entry));
  const deleteBtn = el('button', 'history-item-btn history-item-btn-danger');
  deleteBtn.type = 'button';
  deleteBtn.title = 'Delete record';
  deleteBtn.setAttribute('aria-label', 'Delete record');
  deleteBtn.innerHTML = DELETE_ICON;
  deleteBtn.addEventListener('click', () => {
    if (currentRecord === entry) closeDetail();
    selectedRecords.delete(entry);
    const photoIds = worksheetPhotoIds(entry);
    removeUutRecord(rawEntries.indexOf(entry));
    // After the removal, so photos only this record held are let go of.
    deleteUnusedPhotos(photoIds);
    renderDbList();
  });
  actions.appendChild(shareBtn);
  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);
  row.appendChild(actions);
  return row;
}

// One block per customer folder — folders by name, the unfiled one
// last — and within each, the records in the chosen sort order.
function renderDbList() {
  const rawEntries = loadUutDatabase();
  const allCustomers = loadCustomers();
  // Searched on everything a record is likely to be remembered by.
  const query = dbSearch.value.trim().toLowerCase();
  const matches = (record) => [
    recordLabel(record), record.uutTag, record.uutMaker, record.equipmentId, record.equipmentCert,
    recordFolder(record, allCustomers).name, record.technician, record.calDate,
  ].filter(Boolean).join(' ').toLowerCase().includes(query);
  const entries = sortEntries(query ? rawEntries.filter(matches) : rawEntries);
  // Anything ticked that's no longer in the list isn't ticked any more.
  selectedRecords.forEach((record) => {
    if (!rawEntries.includes(record)) selectedRecords.delete(record);
  });
  updateShareSelectedBtn();
  dbCount.textContent = query ? `(${entries.length} of ${rawEntries.length})` : entries.length > 0 ? `(${entries.length})` : '';
  dbList.innerHTML = '';

  if (entries.length === 0 && query) {
    dbList.appendChild(el('p', 'history-empty', `No saved records match "${dbSearch.value.trim()}".`));
    return;
  }
  if (entries.length === 0) {
    dbList.appendChild(el('p', 'history-empty', 'No saved UUT records yet — use the Save button on the Worksheet page to add one.'));
    return;
  }

  const customers = loadCustomers();
  const folders = new Map();
  entries.forEach((entry) => {
    const folder = recordFolder(entry, customers);
    if (!folders.has(folder.key)) folders.set(folder.key, { ...folder, entries: [] });
    folders.get(folder.key).entries.push(entry);
  });
  const ordered = Array.from(folders.values()).sort((a, b) => {
    if (!a.key !== !b.key) return a.key ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  ordered.forEach((folder) => {
    const block = el('div', 'folder-group');
    const header = el('div', 'folder-header');
    // The folder's own tick box: ticks or unticks everything in it, and
    // shows a dash when only some of it is ticked.
    const ticked = folder.entries.filter((entry) => selectedRecords.has(entry)).length;
    const folderTick = buildTickBox(`Select every worksheet in ${folder.name}`, (checked) => {
      folder.entries.forEach((entry) => {
        if (checked) selectedRecords.add(entry);
        else selectedRecords.delete(entry);
      });
      renderDbList();
    });
    folderTick.checked = ticked === folder.entries.length;
    folderTick.indeterminate = ticked > 0 && ticked < folder.entries.length;
    const heading = el('label', 'folder-heading');
    heading.appendChild(folderTick);
    const title = el('h3', null, folder.name);
    title.appendChild(el('span', 'history-count', ` (${folder.entries.length})`));
    heading.appendChild(title);
    header.appendChild(heading);
    block.appendChild(header);
    folder.entries.forEach((entry) => block.appendChild(buildRecordRow(entry, rawEntries)));
    dbList.appendChild(block);
  });
}

// In the order they're listed: folder by folder, then the chosen sort.
shareSelectedBtn.addEventListener('click', () => {
  const customers = loadCustomers();
  const ordered = sortEntries(loadUutDatabase()).filter((record) => selectedRecords.has(record));
  ordered.sort((a, b) => {
    const fa = recordFolder(a, customers);
    const fb = recordFolder(b, customers);
    if (fa.key === fb.key) return 0;
    if (!fa.key !== !fb.key) return fa.key ? -1 : 1;
    return fa.name.localeCompare(fb.name);
  });
  shareRecords(ordered);
});

clearDbBtn.addEventListener('click', () => {
  if (!window.confirm('Remove all saved UUT records from this device, along with their photos? Worksheets still open on the Worksheet page are not affected.')) return;
  const photoIds = [];
  loadUutDatabase().forEach((record) => photoIds.push(...worksheetPhotoIds(record)));
  clearUutDatabase();
  selectedRecords.clear();
  deleteUnusedPhotos(photoIds);
  closeDetail();
  renderDbList();
});

updateSortDirBtn();
dbSearch.addEventListener('input', renderDbList);

// CUSTOMERS_KEY for the folder names; TABS_STATE_KEY only to know which
// photos an open worksheet still refers to (history.js's photoIdsInUse);
// SHARE_LOG_KEY because sharing adds to it.
hydrateStorage([UUT_DATABASE_KEY, CUSTOMERS_KEY, TABS_STATE_KEY, SHARE_LOG_KEY]).then(() => {
  // Edit goes by a record's id; ones saved before ids are given theirs.
  ensureRecordIds();
  renderDbList();
  // database.html#<record id> — how the Home page's recent worksheets
  // open the one that was pressed.
  const wanted = decodeURIComponent(window.location.hash.slice(1));
  const record = wanted ? loadUutDatabase().find((r) => r && r.id === wanted) : null;
  if (record) renderDetail(record);
});
