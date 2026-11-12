// interpolate.js — "Worksheet" page (Correction Worksheets). Supports
// any number of independent worksheets ("tabs") open at once in this
// one page load — each tab has its own equipment/table/unit selection
// and its own interpolation table — but every tab reads and writes the
// SAME shared scan history (history.js's storage), which scans.html's
// Scans page also browses.
//
// The QR scanner itself lives once on this page (not duplicated per
// tab — that was tried early on and was awkward, one camera instance is
// enough) — a successful scan adds to the shared history AND selects
// that equipment into whichever tab is currently active. Opening a
// past scan from the Scans page and choosing "Use in a worksheet"
// hands off the other way: see history.js's PENDING_WORKSHEET_EQUIP_KEY
// and the boot section at the bottom of this file.
//
// Lab Correction Rdg is linearly interpolated from the selected scope/
// unit table's rows — [labRdg, correction, uncertainty] triples, same
// shape the QR itself encodes (equipment-tracker's exportQrCertificates.js)
// — treating labRdg as the x-axis and correction as the y-axis. A Lab
// Rdg outside the reference table's own min/max range is refused (shown
// as an error in that row) rather than extrapolated or clamped, so the
// tool never silently guesses beyond what was actually measured.

const DEFAULT_ROW_COUNT = 6;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// --- Scan a certificate QR (shared by every tab — one scanner, not one
// per tab) ---
// Ported from what used to be scans.html/app.js's decode logic. A
// successful scan adds the payload to the shared history (same as
// before) and selects it into whichever tab is currently active — see
// setActiveTab()/activeTabId below, declared later in this file but
// already in scope by the time any of this actually runs (user
// interaction, not page load).

const scanCanvas = document.getElementById('scan-canvas');
const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
const scanDropzone = document.getElementById('dropzone');
const scanFileInput = document.getElementById('file-input');
const scanModeUpload = document.getElementById('mode-upload');
const scanModeCamera = document.getElementById('mode-camera');
const scanStatusEl = document.getElementById('scan-status');
const scanInputTabs = document.querySelectorAll('.input-tab');
const scanControlsEl = document.getElementById('scan-controls');
const scanConfirmEl = document.getElementById('scan-confirm');
const scanConfirmTextEl = document.getElementById('scan-confirm-text');
const rescanBtn = document.getElementById('rescan-btn');

// Once the active tab already has equipment selected, the full
// scanner (upload/camera picker) collapses to a one-line confirmation
// so it stops taking up space it no longer needs — Rescan brings it
// back. Reset on every tab switch (see setActiveTab below) so a
// Rescan on one tab doesn't leave another tab's scanner stuck open.
let scanForceExpanded = false;

function updateScanSectionState() {
  const active = tabInstances.find((t) => t.id === activeTabId);
  const state = active ? active.api.getState() : null;
  const collapsed = Boolean(state && state.equipmentId) && !scanForceExpanded;

  scanConfirmEl.classList.toggle('hidden', !collapsed);
  scanControlsEl.classList.toggle('hidden', collapsed);
  if (!collapsed) return;
  // Collapsing hides the viewfinder — e.g. switching to a tab that
  // already has its equipment — so a camera still running under it is
  // stopped rather than left on out of sight.
  qrScanner.stop();

  const entries = loadHistory();
  const entry = entries.find((e) => e.id === state.equipmentId && e.cert === state.equipmentCert);
  scanConfirmTextEl.textContent = '';
  scanConfirmTextEl.appendChild(document.createTextNode('Scanned '));
  const strong = document.createElement('strong');
  strong.textContent = state.equipmentId;
  scanConfirmTextEl.appendChild(strong);
  if (entry && entry.name) scanConfirmTextEl.appendChild(document.createTextNode(` — ${entry.name}`));
}

rescanBtn.addEventListener('click', () => {
  scanForceExpanded = true;
  updateScanSectionState();
});

function showScanStatus(message, isError) {
  scanStatusEl.textContent = message;
  scanStatusEl.classList.remove('hidden');
  scanStatusEl.classList.toggle('scan-status-error', Boolean(isError));
  scanStatusEl.classList.toggle('scan-status-ok', !isError);
}

scanInputTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    scanInputTabs.forEach((t) => t.classList.toggle('active', t === tab));
    const mode = tab.dataset.mode;
    scanModeUpload.classList.toggle('hidden', mode !== 'upload');
    scanModeCamera.classList.toggle('hidden', mode !== 'camera');
    // Choosing "Use camera" is itself the request to scan, so it goes
    // straight to the camera rather than to a second Start button.
    if (mode === 'camera') {
      scanStatusEl.classList.add('hidden');
      qrScanner.start();
    } else {
      qrScanner.stop();
    }
  });
});

scanDropzone.addEventListener('click', () => scanFileInput.click());
scanDropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  scanDropzone.classList.add('dragover');
});
scanDropzone.addEventListener('dragleave', () => scanDropzone.classList.remove('dragover'));
scanDropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  scanDropzone.classList.remove('dragover');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) decodeImageFile(file);
});
scanFileInput.addEventListener('change', () => {
  const file = scanFileInput.files && scanFileInput.files[0];
  if (file) decodeImageFile(file);
  scanFileInput.value = '';
});

function decodeImageFile(file) {
  scanStatusEl.classList.add('hidden');
  const img = new Image();
  const objectUrl = URL.createObjectURL(file);
  img.onload = () => {
    scanCanvas.width = img.naturalWidth;
    scanCanvas.height = img.naturalHeight;
    scanCtx.drawImage(img, 0, 0);
    const imageData = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
    URL.revokeObjectURL(objectUrl);
    decodeQrImage(imageData, true).then((code) => {
      if (!code) {
        showScanStatus('No QR code found in that image. Try a clearer/closer photo of just the code.', true);
        return;
      }
      handleDecodedQr(code);
    });
  };
  img.onerror = () => {
    URL.revokeObjectURL(objectUrl);
    showScanStatus('Could not read that file as an image.', true);
  };
  img.src = objectUrl;
}

// The camera side — the full-page viewfinder, auto-zoom, torch, success
// feedback — is scanner.js. All it needs from this page is what counts
// as a certificate QR (scanner.js's readCertificateQr) and what to do
// with one (acceptCertificate, below). A code that isn't a certificate
// leaves the camera running: the scanner shows a short reason over the
// picture, and the full one is left in the status line under it for
// when the scanner closes.
const qrScanner = createQrScanner({
  root: document.getElementById('scanner'),
  validate(code) {
    const { payload, error, hint } = readCertificateQr(code);
    if (!payload) {
      showScanStatus(error, true);
      return { rejected: hint };
    }
    if (!hasValidCertificate(payload)) {
      // Not a code to keep scanning past — the camera closes first, so
      // the pop-up isn't sitting on top of a live viewfinder.
      setTimeout(() => {
        qrScanner.stop();
        refuseDueCertificate(payload);
      }, 0);
      return {};
    }
    return { accepted: payload };
  },
  onResult: acceptCertificate,
});
document.querySelectorAll('#scanner [data-role="start"]').forEach((btn) => {
  btn.addEventListener('click', () => scanStatusEl.classList.add('hidden'));
});

// A label with no certificate still within its due date (history.js's
// hasValidCertificate) is turned away rather than saved: a message
// pops up saying so, and it stays in the status line for after the
// pop-up is dismissed. One with some certificates past their date and
// some not is taken: the ones that are past can't be picked for a
// table, and the status line says how many that is.
function refuseDueCertificate(payload) {
  const message = dueCertificateMessage(payload);
  showScanStatus(message, true);
  window.alert(message);
}

function acceptCertificate(payload) {
  addToHistory(payload);
  const activeTab = tabInstances.find((t) => t.id === activeTabId) || tabInstances[0];
  scanForceExpanded = false; // a fresh scan re-collapses the scanner, even after a manual Rescan
  if (activeTab) activeTab.api.selectEquipment(payload);
  const label = payload.name ? `${payload.id} — ${payload.name}` : payload.id;
  const certificates = scanCertificates(payload);
  const past = certificates.filter((certificate) => isCalibrationDue(certificate.due)).length;
  const pastNote = past > 0 ? ` ${past} of its ${certificates.length} certificates ${past === 1 ? 'is' : 'are'} past the due date and can't be used.` : '';
  showScanStatus(`✓ Scanned ${label} — added to Calibration info below.${pastNote}`, false);
}

function handleDecodedQr(code) {
  const { payload, error } = readCertificateQr(code);
  if (!payload) showScanStatus(error, true);
  else if (!hasValidCertificate(payload)) refuseDueCertificate(payload);
  else acceptCertificate(payload);
}

// --- Unit conversion (Pressure, Temperature, Current & Voltage) ---
// Stateless — shared by every tab, no per-worksheet state involved.

// Multiplier to Pa for each supported pressure unit — conversion between
// any two units is (value * fromUnit) / toUnit.
const PRESSURE_TO_PA = {
  Pa: 1,
  hPa: 100,
  kPa: 1000,
  MPa: 1e6,
  mbar: 100,
  bar: 1e5,
  psi: 6894.757293168361,
  'kgf/cm²': 98066.5,
  mmHg: 133.322387415,
  inHg: 3386.389,
  atm: 101325,
};

// Celsius-based conversion for temperature — offsets mean this can't use
// a simple multiplier table like pressure.
const TEMPERATURE_TO_CELSIUS = {
  '°C': (v) => v,
  '°F': (v) => ((v - 32) * 5) / 9,
  K: (v) => v - 273.15,
};
const CELSIUS_TO_TEMPERATURE = {
  '°C': (v) => v,
  '°F': (v) => (v * 9) / 5 + 32,
  K: (v) => v + 273.15,
};

// Multiplier to A for each supported current unit.
const CURRENT_TO_A = {
  A: 1,
  mA: 1e-3,
  uA: 1e-6,
};

// Multiplier to V for each supported voltage unit.
const VOLTAGE_TO_V = {
  V: 1,
  mV: 1e-3,
  uV: 1e-6,
};

// Maps the many ways a unit might be written in certificate data (case,
// spacing, "degC" vs "°C", etc.) onto one of the canonical keys above.
const UNIT_ALIASES = {
  pa: 'Pa', 'n/m2': 'Pa', 'n/m²': 'Pa',
  hpa: 'hPa',
  kpa: 'kPa',
  mpa: 'MPa',
  mbar: 'mbar', mb: 'mbar',
  bar: 'bar',
  psi: 'psi', psia: 'psi', psig: 'psi',
  'kgf/cm2': 'kgf/cm²', 'kgf/cm²': 'kgf/cm²', 'kg/cm2': 'kgf/cm²', 'kg/cm²': 'kgf/cm²',
  mmhg: 'mmHg',
  inhg: 'inHg',
  atm: 'atm',
  c: '°C', '°c': '°C', degc: '°C', 'deg c': '°C', celsius: '°C',
  f: '°F', '°f': '°F', degf: '°F', 'deg f': '°F', fahrenheit: '°F',
  k: 'K', kelvin: 'K',
  a: 'A', amp: 'A', amps: 'A', ampere: 'A', amperes: 'A',
  ma: 'mA', milliamp: 'mA', milliamps: 'mA',
  ua: 'uA', 'µa': 'uA', microamp: 'uA', microamps: 'uA',
  v: 'V', volt: 'V', volts: 'V',
  mv: 'mV', millivolt: 'mV', millivolts: 'mV',
  uv: 'uV', 'µv': 'uV', microvolt: 'uV', microvolts: 'uV',
};

function normalizeUnit(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  return UNIT_ALIASES[key] || UNIT_ALIASES[key.replace(/\s+/g, '')] || null;
}

function unitCategory(canonicalUnit) {
  if (canonicalUnit in PRESSURE_TO_PA) return 'pressure';
  if (canonicalUnit in TEMPERATURE_TO_CELSIUS) return 'temperature';
  if (canonicalUnit in CURRENT_TO_A) return 'current';
  if (canonicalUnit in VOLTAGE_TO_V) return 'voltage';
  return null;
}

// Category → its multiplier table, for the categories (pressure,
// current, voltage) that convert the same simple way — no offset like
// temperature needs.
const MULTIPLIER_TABLE_BY_CATEGORY = {
  pressure: PRESSURE_TO_PA,
  current: CURRENT_TO_A,
  voltage: VOLTAGE_TO_V,
};

// Category → the units offered in the UUT unit dropdown.
const UNITS_BY_CATEGORY = {
  pressure: Object.keys(PRESSURE_TO_PA),
  temperature: Object.keys(TEMPERATURE_TO_CELSIUS),
  current: Object.keys(CURRENT_TO_A),
  voltage: Object.keys(VOLTAGE_TO_V),
};

function convertUnit(value, fromUnit, toUnit, category) {
  if (!Number.isFinite(value) || fromUnit === toUnit) return value;
  if (category === 'temperature') {
    const toC = TEMPERATURE_TO_CELSIUS[fromUnit];
    const fromC = CELSIUS_TO_TEMPERATURE[toUnit];
    if (!toC || !fromC) return value;
    return fromC(toC(value));
  }
  const table = MULTIPLIER_TABLE_BY_CATEGORY[category];
  if (table) {
    const fromFactor = table[fromUnit];
    const toFactor = table[toUnit];
    if (!fromFactor || !toFactor) return value;
    return (value * fromFactor) / toFactor;
  }
  return value;
}

// --- Row math helpers (stateless) ---

function formatNumber(n) {
  if (!Number.isFinite(n)) return '—';
  // Up to 6 decimal places, trimmed of trailing zeros — matches the
  // precision certificate data is typically recorded at without printing
  // long floating-point tails from the interpolation arithmetic.
  return parseFloat(n.toFixed(6)).toString();
}

// Averages every number found in a UUT Rdg cell — accepts more than one
// reading separated by commas, whitespace, or "/" (e.g. "10.1, 10.3 10.2"),
// per the explicit ask that this column feed an AVERAGE UUT reading into
// the Correction Rdg formula. A single number is just an average of one.
function parseUutAverage(text) {
  const nums = (text || '')
    .split(/[,\s/]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  if (nums.length === 0) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

// A Scale Resolution as typed — "0.02" — is the UUT's readability: the
// smallest step its display moves in, so every reading it can show is a
// multiple of that. Returns the step and the decimal places it's
// written to ("0.02" → 2, "0.5" → 1, "1" → 0), or null when the field
// is blank, zero, or not a plain number.
function parseResolution(text) {
  const match = (text || '').trim().match(/^\d*\.?(\d*)$/);
  if (!match || !/\d/.test(match[0])) return null;
  const step = Number(match[0]);
  return step > 0 ? { step, decimals: match[1].length } : null;
}

// One reading moved to the nearest multiple of the resolution — 57.03
// at 0.02 is 57.04 — and written to its decimal places. A reading
// exactly halfway between two steps goes to the one further from zero.
// Done in whole numbers (both scaled up until neither has a fraction),
// because 57.03 / 0.02 in floating point is a hair under 2851.5 and
// would round the wrong way.
function snapToResolution(value, resolution) {
  const plain = String(Math.abs(value));
  if (plain.includes('e')) return value.toFixed(resolution.decimals);
  const valueDecimals = plain.includes('.') ? plain.length - plain.indexOf('.') - 1 : 0;
  const scale = 10 ** Math.max(valueDecimals, resolution.decimals);
  const stepUnits = Math.round(resolution.step * scale);
  const valueUnits = Math.round(Math.abs(value) * scale);
  const snapped = (Math.round(valueUnits / stepUnits) * stepUnits) / scale;
  return (value < 0 ? -snapped : snapped).toFixed(resolution.decimals);
}

// Every reading in a UUT Rdg cell (see parseUutAverage for what can
// separate them) snapped to the resolution; the separators, and
// anything that isn't a number, are left as typed.
function snapReadings(text, resolution) {
  return (text || '').replace(/[^,\s/]+/g, (token) => (Number.isFinite(Number(token)) ? snapToResolution(Number(token), resolution) : token));
}

function getSortedPoints(table) {
  if (!table || !Array.isArray(table.rows)) return [];
  const points = table.rows
    .map((row) => ({ x: parseFloat(row[0]), y: parseFloat(row[1]) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  points.sort((a, b) => a.x - b.x);
  const seenX = new Set();
  return points.filter((p) => {
    if (seenX.has(p.x)) return false;
    seenX.add(p.x);
    return true;
  });
}

// Blank when the field isn't present in the saved scan data, rather
// than printing "undefined" or "null" in the certificate-info row.
function cellText(value) {
  return value ? String(value) : '—';
}

// Same 30/60-day thresholds as app.js's computeDueStatus (duplicated,
// not shared — this file has no module system, same pattern as el()/
// cellText() above) — used for the small inline due-status badge next
// to Cal. Due Date in Calibration info.
function dueStatusBadge(dueDateStr) {
  if (!dueDateStr) return null;
  const dueDate = new Date(dueDateStr);
  if (Number.isNaN(dueDate.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysUntil = Math.floor((dueDate - today) / (1000 * 60 * 60 * 24));
  if (daysUntil < 0) return { cls: 'info-dl-due-overdue', text: `Overdue ${Math.abs(daysUntil)}d` };
  if (daysUntil < 30) return { cls: 'info-dl-due-overdue', text: `Due ${daysUntil}d` };
  if (daysUntil < 60) return { cls: 'info-dl-due-aware', text: `Due ${daysUntil}d` };
  return { cls: 'info-dl-due-safe', text: `Valid, ${daysUntil}d` };
}

// --- Tab (worksheet) management ---
// scans.html and interpolate.html are separate static pages, not a
// single-page app — following the sidebar link (or refreshing) fully
// reloads this script, which would otherwise rebuild every tab from
// scratch. TABS_STATE_KEY (history.js) persists the full set of
// worksheets (each one's entered Lab Rdg/UUT Rdg values plus its
// equipment/table/unit selection) through history.js's store, same as
// the shared scan history, so leaving and returning — or reloading —
// restores exactly what was there, tabs and all.
//
// Worksheets are filed under customer folders (history.js's
// CUSTOMERS_KEY): each one carries the customerId of the folder it was
// created in, the tab strip shows only the worksheets of the folder
// that's open, and "+" adds to that folder. A null customerId is the
// unfiled folder — which is where every worksheet from before folders
// existed sits.

// Legacy single-worksheet key from before tabs existed — migrated into
// the new multi-tab schema (as a lone "Tab 1") the first time this page
// loads after the upgrade.
const LEGACY_STATE_KEY = 'certqr:interpState';

const tabStripEl = document.getElementById('tab-strip-tabs');
const addTabBtn = document.getElementById('add-tab-btn');
const tabPanelsEl = document.getElementById('tab-panels');
const tabTemplate = document.getElementById('tab-panel-template');
const customerSelect = document.getElementById('customer-select');
const customerAddBtn = document.getElementById('customer-add');
const customerRenameBtn = document.getElementById('customer-rename');
const customerDeleteBtn = document.getElementById('customer-delete');

let tabInstances = []; // [{ id, root, chipEl, api, customerId }]
let activeTabId = null;
let activeCustomerId = null; // the folder that's open; null = unfiled

function makeTabId() {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadTabsState() {
  const parsed = readStore(TABS_STATE_KEY, null);
  if (parsed && Array.isArray(parsed.tabs) && parsed.tabs.length > 0) return parsed;
  // LEGACY_STATE_KEY predates both tabs and history.js's store — it was
  // never migrated into TABS_STATE_KEY's entry there, so this one-time
  // fallback still reads straight from localStorage.
  try {
    const legacyRaw = localStorage.getItem(LEGACY_STATE_KEY);
    const legacy = legacyRaw ? JSON.parse(legacyRaw) : null;
    if (legacy) return { activeTabId: null, tabs: [{ id: makeTabId(), ...legacy }] };
  } catch {
    // fall through to "no saved state"
  }
  return null;
}

function folderTabs(customerId) {
  return tabInstances.filter((t) => t.customerId === customerId);
}

function saveTabsState() {
  const tabs = tabInstances.map((t) => ({ id: t.id, customerId: t.customerId, ...t.api.getState() }));
  writeStore(TABS_STATE_KEY, { activeTabId, activeCustomerId, tabs });
  // Cheap enough to redo on every change (a handful of tabs, each just a
  // DOM-value read via getState()) — keeps a tab's chip label in sync
  // the moment Save renames it, without a separate "label changed" path.
  renderTabStrip();
  // Same story for the scan section's collapsed/expanded state — this
  // is every worksheet's onChange callback, so it fires on a scan, a
  // manual equipment selection, or a tab switch alike.
  updateScanSectionState();
}

// A tab's chip shows "Tab N" until it's been saved at least once, then
// switches to its saved UUT label (formatUutLabel, history.js) — see
// the Save button handler in createTabPanel below.
function tabLabel(tab, index) {
  const state = tab.api.getState();
  if (state.savedAtLeastOnce) {
    const label = formatUutLabel(state.uutModel, state.uutSerial);
    if (label) return label;
  }
  return `Tab ${index + 1}`;
}

// Only the open folder's worksheets get a chip; N in "Tab N" counts
// within that folder.
function renderTabStrip() {
  tabStripEl.innerHTML = '';
  const visible = folderTabs(activeCustomerId);
  visible.forEach((tab, index) => {
    const chip = el('button', 'tab-chip' + (tab.id === activeTabId ? ' active' : ''));
    chip.type = 'button';
    chip.appendChild(el('span', null, tabLabel(tab, index)));
    if (visible.length > 1) {
      const closeBtn = el('span', 'tab-chip-close');
      closeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeTab(tab.id);
      });
      chip.appendChild(closeBtn);
    }
    chip.addEventListener('click', () => setActiveTab(tab.id));
    tab.chipEl = chip;
    tabStripEl.appendChild(chip);
  });
}

function setActiveTab(id) {
  if (id === activeTabId) return;
  const previous = tabInstances.find((t) => t.id === activeTabId);
  if (previous) {
    previous.root.classList.add('hidden');
    if (previous.chipEl) previous.chipEl.classList.remove('active');
  }
  const next = tabInstances.find((t) => t.id === id);
  if (!next) return;
  activeTabId = id;
  next.root.classList.remove('hidden');
  if (next.chipEl) next.chipEl.classList.add('active');
  scanForceExpanded = false;
  saveTabsState();
}

// A new worksheet goes into whichever folder is open.
// The type a worksheet started now is given: with Settings on
// "Worksheet", the official worksheet last worked on (the first of
// them, to begin with); on "Unofficial record", none — the simple table.
const LAST_WORKSHEET_TYPE_KEY = 'certqr:lastWorksheetType';

function defaultWorksheetType() {
  if (loadSettings().recordMode !== 'worksheet') return '';
  let last = null;
  try {
    last = localStorage.getItem(LAST_WORKSHEET_TYPE_KEY);
  } catch {
    last = null;
  }
  return worksheetForm(last) ? last : WORKSHEET_FORMS[0].id;
}

// `initialState` with no worksheetType in it is a worksheet being
// started; one being brought back (a saved record opened again) says
// what it is, the simple table included.
function addTab(initialState) {
  if (!initialState || !('worksheetType' in initialState)) initialState = { ...(initialState || {}), worksheetType: defaultWorksheetType() };
  const id = makeTabId();
  const root = tabTemplate.content.firstElementChild.cloneNode(true);
  root.classList.add('hidden');
  tabPanelsEl.appendChild(root);
  const api = createTabPanel(id, root, initialState, saveTabsState);
  tabInstances.push({ id, root, chipEl: null, api, customerId: activeCustomerId });
  renderTabStrip();
  setActiveTab(id);
  saveTabsState();
  return id;
}

function removeTab(id) {
  const removed = tabInstances.find((t) => t.id === id);
  if (!removed) return;
  const folderIndex = folderTabs(removed.customerId).indexOf(removed);
  const photoIds = worksheetPhotoIds(removed.api.getState());
  tabInstances.splice(tabInstances.indexOf(removed), 1);
  removed.root.remove();

  const siblings = folderTabs(removed.customerId);
  if (siblings.length === 0) {
    // Never leave a folder with zero worksheets.
    addTab(null);
  } else if (activeTabId === id) {
    activeTabId = null; // force setActiveTab below to actually switch
    setActiveTab(siblings[Math.min(folderIndex, siblings.length - 1)].id);
  } else {
    saveTabsState();
  }
  // After the save above, so a photo this worksheet shared with nothing
  // else is seen as let go of.
  deleteUnusedPhotos(photoIds);
}

addTabBtn.addEventListener('click', () => addTab(null));

// --- Customer folders ---
function renderCustomerSelect() {
  customerSelect.innerHTML = '';
  customerSelect.appendChild(el('option', null, UNFILED_LABEL)).value = '';
  loadCustomers()
    .slice()
    .sort((x, y) => x.name.localeCompare(y.name))
    .forEach((customer) => {
      customerSelect.appendChild(el('option', null, customer.name)).value = customer.id;
    });
  customerSelect.value = activeCustomerId || '';
  // The unfiled folder isn't one that can be renamed or deleted.
  customerRenameBtn.disabled = activeCustomerId === null;
  customerDeleteBtn.disabled = activeCustomerId === null;
}

// Opens a folder: its worksheets take over the tab strip. One that has
// none yet is given a blank worksheet to start on.
function setActiveCustomer(customerId) {
  activeCustomerId = customerId;
  renderCustomerSelect();
  const inFolder = folderTabs(customerId);
  if (inFolder.length === 0) {
    addTab(null);
  } else if (inFolder.some((t) => t.id === activeTabId)) {
    saveTabsState();
  } else {
    setActiveTab(inFolder[0].id);
  }
}

// Asks for a folder name. Null if that was cancelled, left blank, or is
// the name of another folder (which gets its own message).
function askCustomerName(message, currentName) {
  const answer = window.prompt(message, currentName || '');
  if (answer === null) return null;
  const name = answer.trim();
  if (!name) return null;
  const taken = loadCustomers().some((c) => c.name !== currentName && c.name.toLowerCase() === name.toLowerCase());
  if (taken) {
    window.alert(`There is already a folder called "${name}".`);
    return null;
  }
  return name;
}

customerSelect.addEventListener('change', () => setActiveCustomer(customerSelect.value || null));

customerAddBtn.addEventListener('click', () => {
  const name = askCustomerName('Customer name for the new folder:');
  if (!name) return;
  const customer = { id: `cust-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name };
  saveCustomers([...loadCustomers(), customer]);
  setActiveCustomer(customer.id);
});

customerRenameBtn.addEventListener('click', () => {
  const current = loadCustomers().find((c) => c.id === activeCustomerId);
  if (!current) return;
  const name = askCustomerName('Rename this customer folder:', current.name);
  if (!name) return;
  saveCustomers(loadCustomers().map((c) => (c.id === current.id ? { ...c, name } : c)));
  renderCustomerSelect();
});

// The folder goes; what's in it doesn't. Its open worksheets move to
// the unfiled folder, and records saved from it keep the customer name
// they were saved with.
customerDeleteBtn.addEventListener('click', () => {
  const current = loadCustomers().find((c) => c.id === activeCustomerId);
  if (!current) return;
  if (!window.confirm(`Delete the folder "${current.name}"?\n\nIts open worksheets move to "${UNFILED_LABEL}". Records already saved under it are kept.`)) return;
  folderTabs(current.id).forEach((tab) => {
    tab.customerId = null;
  });
  saveCustomers(loadCustomers().filter((c) => c.id !== current.id));
  setActiveCustomer(null);
});

// What a record saved from this worksheet is filed under — the folder's
// name goes along with its id, so the record still says whose it was if
// the folder is deleted later.
function tabCustomerFields(tabId) {
  const tab = tabInstances.find((t) => t.id === tabId);
  const customer = tab && tab.customerId ? loadCustomers().find((c) => c.id === tab.customerId) : null;
  return { customerId: customer ? customer.id : null, customerName: customer ? customer.name : null };
}

// Today, as a date input wants it (the local date, not UTC's).
function todayDateValue() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// --- Per-tab worksheet factory ---
// Everything below used to be page-global state and document.getElementById
// lookups; now scoped to one cloned copy of #tab-panel-template so any
// number of worksheets can run side by side without clobbering each
// other's DOM or state. `root` is that clone; `persist` is called after
// anything the worksheet does that should be saved.
//
// A worksheet holds one or more reading tables (createReadingTable,
// inside) — each its own interpolation table, read against one
// scope/unit table of one of the equipment's certificates and marked as
// taken before or after the UUT was adjusted. What all of them share
// lives at this level: the reference equipment, the UUT's details, the
// remarks.
const readingTableTemplate = document.getElementById('reading-table-template');

function createTabPanel(id, root, initialState, persist) {
  const q = (role) => root.querySelector(`[data-role="${role}"]`);

  // What everything below calls after a change. The change is saved,
  // and it may also have changed what a photo is a photo of — a reading
  // retyped, a row or table removed above it, the UUT given its name —
  // so once things have been still for a moment the photo files are
  // renamed to match (photos.js's renamePhoto; only the Android app has
  // files to rename).
  let photoNamesTimer = null;
  function syncPhotoNames() {
    const state = getState();
    worksheetPhotoNames(state, formatUutLabel(state.uutModel, state.uutSerial))
      .forEach((photo) => renamePhoto(photo.id, photo.name));
  }
  function onChange() {
    refreshSummaries();
    persist();
    clearTimeout(photoNamesTimer);
    photoNamesTimer = setTimeout(syncPhotoNames, 800);
  }

  const equipmentSelect = q('equipment-select');
  const noScansNote = q('no-scans-note');
  const equipmentDescCell = q('equipment-desc');
  const equipmentCertsCell = q('equipment-certs');
  const uutModelInput = q('uut-model');
  const uutSerialInput = q('uut-serial');
  const uutTagInput = q('uut-tag');
  const uutMakerInput = q('uut-maker');
  const uutRangeInput = q('uut-range');
  const uutResolutionInput = q('uut-resolution');
  const remarksInput = q('remarks');
  const tablesEl = q('tables');
  const pagerEl = q('table-pager');
  const pagerLabel = q('pager-label');
  const pagerDots = q('pager-dots');
  const pagerPrev = q('pager-prev');
  const pagerNext = q('pager-next');
  const addTableBtn = q('add-table');
  const saveBtn = q('save-btn');
  const saveStatus = q('save-status');
  const saveLabel = q('save-label');
  const saveNewBtn = q('save-new-btn');
  const resultChip = q('result-chip');
  const calDateInput = q('cal-date');
  const technicianInput = q('technician');
  const ambientTempInput = q('ambient-temp');
  const ambientHumidityInput = q('ambient-humidity');
  const typeRow = q('type-row');
  const typeSelect = q('worksheet-type');

  // Scale resolution takes a number and nothing else (history.js's
  // restrictInput) — one that's never negative. Set up here, ahead of
  // every other listener on the box, so those only see the cleaned text.
  restrictInput(uutResolutionInput, (text) => cleanNumberText(text, false));
  // So do the two ambient readings; a temperature can be below zero.
  restrictInput(ambientTempInput, (text) => cleanNumberText(text, true));
  restrictInput(ambientHumidityInput, (text) => cleanNumberText(text, false));

  // The saved record this worksheet is the working copy of, once it has
  // been saved (or was opened from one): Save then writes over that
  // record instead of adding another beside it.
  let recordId = initialState && initialState.recordId ? initialState.recordId : null;
  // The reference equipment, by its ID (null: none chosen) — not by a
  // place in the list of scans, which shifts whenever one is added.
  // Equipment can have more than one certificate on the go, all of
  // them on its label, so which certificate a reading is corrected by
  // is chosen table by table (createReadingTable), not here.
  let selectedEquipmentId = null;
  // Which official worksheet this is — an id from worksheet-forms.js —
  // or '' for an unofficial record, with the simple table. Every
  // reading table of the worksheet is of this type.
  //
  // Settings decides which of the two the page makes, and a worksheet
  // with no readings in it yet simply follows Settings: it is made
  // over as what the page now makes. One that has readings is never
  // made over behind the user's back — it keeps the table it has
  // (and, with Settings on "Worksheet", is offered the types to
  // choose from).
  let worksheetType = initialState && worksheetForm(initialState.worksheetType) ? initialState.worksheetType : '';
  const worksheetMode = loadSettings().recordMode === 'worksheet';
  const startsBlank = worksheetTables(initialState).every((table) => (table && Array.isArray(table.rows) ? table.rows : []).every(isBlankRow));
  const typeAsSaved = worksheetType;
  if (startsBlank && worksheetMode && worksheetType === '') worksheetType = defaultWorksheetType();
  if (startsBlank && !worksheetMode) worksheetType = '';
  // Made over: its empty rows are not kept, so that it starts with as
  // many as a new one of its kind does.
  const madeOver = worksheetType !== typeAsSaved;
  // The one certificate the whole worksheet was made with, for a
  // worksheet from before that choice moved to its tables: what its
  // tables start on.
  const inheritedCert = initialState && initialState.equipmentCert != null ? initialState.equipmentCert : null;
  // Flips true the first time this worksheet is Saved — once true, the
  // tab's chip label switches from "Tab N" to its UUT model/serial (see
  // tabLabel() above) and stays that way even if the fields are cleared.
  let hasSavedRecord = false;
  // This worksheet's reading tables, in the order they're on the page —
  // what createReadingTable returns for each.
  const tables = [];

  // Every certificate held for the worksheet's equipment, each with its
  // own tables — history.js's heldCertificates: those on its latest
  // label first, then any that are only on an earlier one.
  function equipmentCertificates() {
    return selectedEquipmentId === null ? [] : heldCertificates(selectedEquipmentId);
  }

  // One of them, by its certificate number, or null.
  function certificateEntry(cert) {
    return equipmentCertificates().find((entry) => entry.cert === cert) || null;
  }

  // What the equipment is, as its most recent scan describes it.
  function equipmentName() {
    const scan = selectedEquipmentId === null ? null : loadHistory().find((entry) => entry.id === selectedEquipmentId);
    return scan ? scan.name || '' : '';
  }
  // The certificate a table starts on: the first of them that is still
  // within its due date. Null if there is none.
  function defaultCertificate() {
    const usable = equipmentCertificates().find((entry) => !isCalibrationDue(entry.due));
    return usable ? usable.cert : null;
  }

  // One dropdown option per distinct Equipment ID, in the order each
  // was last scanned. Re-selects selectedEquipmentId, so calling this
  // again after another tab (or this one) adds a scan doesn't lose this
  // tab's selection. Equipment with every certificate past its due date
  // is listed but can't be picked — except by the worksheet that
  // already has it.
  function populateEquipmentSelect() {
    const entries = loadHistory();
    equipmentSelect.innerHTML = '';
    equipmentSelect.appendChild(el('option', null, '— Select —')).value = '';

    if (entries.length === 0) {
      noScansNote.classList.remove('hidden');
      equipmentSelect.disabled = true;
      return;
    }
    noScansNote.classList.add('hidden');
    equipmentSelect.disabled = false;

    // ID → whether any certificate of it, on any scan, is still good.
    const usable = new Map();
    entries.forEach((entry) => {
      if (!entry.id) return;
      usable.set(entry.id, Boolean(usable.get(entry.id)) || hasValidCertificate(entry));
    });
    usable.forEach((good, equipmentId) => {
      const opt = el('option', null, `${equipmentId}${good ? '' : ' (calibration due)'}`);
      opt.value = equipmentId;
      opt.disabled = !good && equipmentId !== selectedEquipmentId;
      equipmentSelect.appendChild(opt);
    });
    equipmentSelect.value = selectedEquipmentId !== null && usable.has(selectedEquipmentId) ? selectedEquipmentId : '';
  }

  // What Calibration info says about the equipment: its description,
  // and a line for each certificate held for it — number, due date and
  // how that stands, traceability. Those are what each table has to
  // choose from.
  function renderEquipmentInfo() {
    const certificates = equipmentCertificates();
    equipmentDescCell.textContent = cellText(equipmentName());
    equipmentCertsCell.innerHTML = '';
    if (certificates.length === 0) {
      equipmentCertsCell.textContent = '—';
      return;
    }
    certificates.forEach((entry) => {
      const line = el('div', 'cert-line');
      line.appendChild(el('span', 'cert-line-no', entry.cert || '(no certificate no.)'));
      const details = [entry.due ? `due ${entry.due}` : '', entry.trace].filter(Boolean).join(' · ');
      if (details) line.appendChild(el('span', 'cert-line-meta', details));
      const badge = dueStatusBadge(entry.due);
      if (badge) line.appendChild(el('span', `info-dl-due ${badge.cls}`, `· ${badge.text}`));
      equipmentCertsCell.appendChild(line);
    });
  }

  // Other equipment was picked from the dropdown: every reading table
  // starts over on it — its newest good certificate, and that
  // certificate's first scope/unit table.
  function updateEquipment() {
    selectedEquipmentId = equipmentSelect.value !== '' ? equipmentSelect.value : null;
    renderEquipmentInfo();
    const cert = defaultCertificate();
    tables.forEach((table) => table.useCertificate(cert));
  }
  equipmentSelect.addEventListener('change', () => { updateEquipment(); onChange(); });
  // A scan made just now — in this tab or another — only lands in
  // history at that moment, so refresh the option list right before the
  // dropdown opens rather than risk it going stale.
  equipmentSelect.addEventListener('mousedown', () => populateEquipmentSelect());
  equipmentSelect.addEventListener('focus', () => populateEquipmentSelect());
  uutModelInput.addEventListener('input', () => onChange());
  uutSerialInput.addEventListener('input', () => onChange());
  // Tag No., Maker and Range describe the UUT and nothing more, and
  // Remarks is whatever the user wants noted about the job — free text
  // that's kept with the worksheet and its saved record, not read by
  // any of the calculations below.
  // Calibration date, technician and the ambient readings are details
  // of the job in the same way: kept, shown, and nothing more.
  // SR (scale resolution) is the exception. It's what Correction Rdg is
  // rounded to, so the rows are worked out again as it's typed — which
  // has to happen before the change is passed on, for the summaries to
  // be of the new figures.
  uutResolutionInput.addEventListener('input', () => recomputeAllRows());
  [uutTagInput, uutMakerInput, uutRangeInput, uutResolutionInput, remarksInput, calDateInput, technicianInput, ambientTempInput, ambientHumidityInput].forEach((input) => {
    input.addEventListener('input', () => onChange());
  });
  // SR (scale resolution) is also what the keyed-in UUT readings are
  // held to: every row's UUT Rdg is moved to the nearest multiple of it
  // (see applyResolution in addRow). On `change` — once the field is
  // left — not on every keystroke: typing "0.02" passes through "0.0"
  // and "0" on the way, and a reading rounded to one of those is gone.
  uutResolutionInput.addEventListener('change', () => {
    tables.forEach((table) => table.applyResolution());
    recomputeAllRows();
    onChange();
  });

  function recomputeAllRows() {
    tables.forEach((table) => table.recompute());
  }

  // --- Sections that fold ---
  // Calibration info, UUT info, Calibration details and Remarks each
  // fold away under their heading, leaving a line that says what's in
  // them — a worksheet on a phone is a long scroll otherwise. (Reading
  // tables fold the same way, each keeping its own state.) Which are
  // folded is kept with the worksheet.
  const foldedSections = new Set(initialState && Array.isArray(initialState.collapsed) ? initialState.collapsed : []);
  const sectionSyncs = [];

  function setUpFold(key, summarise) {
    const section = root.querySelector(`[data-section="${key}"]`);
    const button = section.querySelector('[data-role="fold"]');
    const summary = section.querySelector('[data-role="fold-summary"]');
    const sync = () => {
      const folded = foldedSections.has(key);
      section.classList.toggle('section-collapsed', folded);
      button.setAttribute('aria-expanded', String(!folded));
      summary.textContent = folded ? summarise() : '';
    };
    button.addEventListener('click', () => {
      if (foldedSections.has(key)) foldedSections.delete(key);
      else foldedSections.add(key);
      onChange();
    });
    sectionSyncs.push(sync);
  }
  // Folded, Calibration info names the equipment and the certificates
  // its tables are actually read against.
  setUpFold('reference', () => {
    if (selectedEquipmentId === null) return 'nothing selected';
    const certs = [];
    tables.forEach((table) => {
      const cert = table.getCertificate();
      if (cert && !certs.includes(cert)) certs.push(cert);
    });
    return [selectedEquipmentId, certs.join(', ')].filter(Boolean).join(' · ');
  });
  setUpFold('uut', () => formatUutLabel(uutModelInput.value, uutSerialInput.value) || 'not filled in');
  setUpFold('details', () => [calDateInput.value, technicianInput.value.trim()].filter(Boolean).join(' · ') || 'not filled in');
  setUpFold('remarks', () => {
    const text = remarksInput.value.trim();
    if (!text) return 'none';
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  });

  // --- The worksheet at a glance ---
  // How it stands overall, from every table's rows: failed if any
  // reading is out of tolerance, passed if readings were judged and
  // none is, nothing to say while there's no accuracy to judge by.
  function worksheetVerdict() {
    let judged = 0;
    let failed = 0;
    tables.forEach((table) => {
      const verdicts = table.getVerdicts();
      judged += verdicts.judged;
      failed += verdicts.failed;
    });
    return { judged, failed, result: failed > 0 ? 'fail' : judged > 0 ? 'pass' : '' };
  }

  // Whether the record this worksheet was saved as is still there to
  // be saved over — it may have been deleted on the Records page since.
  function linkedRecord() {
    return recordId ? loadUutDatabase().find((record) => record && record.id === recordId) || null : null;
  }

  // Everything on the page that's a summary of something else: the
  // folded sections' lines, the result beside Save, and what Save will
  // do. Redone after every change (see onChange).
  function refreshSummaries() {
    syncPager();
    sectionSyncs.forEach((sync) => sync());
    tables.forEach((table) => table.refreshSummary());
    const verdict = worksheetVerdict();
    resultChip.className = `result-chip${verdict.result ? ` result-chip-${verdict.result}` : ' hidden'}`;
    if (verdict.result === 'fail') resultChip.textContent = `Fail — ${verdict.failed} of ${verdict.judged} reading${verdict.judged === 1 ? '' : 's'} out of tolerance`;
    else if (verdict.result === 'pass') resultChip.textContent = `Pass — ${verdict.judged} reading${verdict.judged === 1 ? '' : 's'} within tolerance`;
    else resultChip.textContent = '';
    const linked = Boolean(linkedRecord());
    saveLabel.textContent = linked ? 'Update record' : 'Save worksheet';
    saveNewBtn.classList.toggle('hidden', !linked);
  }

  // --- Reading tables ---
  // One table of readings: a clone of #reading-table-template with its
  // own certificate, scope/unit table, UUT unit, before/after-adjust
  // mark and rows. `tableState` is what its getState() returned last
  // time ({ cert, tableIndex, uutUnit, stage, tolType, tolPct, tolFs,
  // tolAdd, rows }), or just part of that for a table being added now;
  // null starts a blank one.
  function createReadingTable(tableState) {
    const section = readingTableTemplate.content.firstElementChild.cloneNode(true);
    const tq = (role) => section.querySelector(`[data-role="${role}"]`);

    const titleEl = tq('table-title');
    const stageChip = tq('stage-chip');
    const removeTableBtn = tq('remove-table');
    const foldBtn = tq('fold');
    const foldSummary = tq('fold-summary');
    const certSelect = tq('cert-select');
    const fnRow = tq('fn-row');
    const fnInput = tq('fn');
    const stageRow = section.querySelector('.stage-row');
    // The official layout this table follows (worksheet-forms.js), or
    // null for the simple table; and, for a layout, its rows.
    const form = worksheetForm(worksheetType);
    let formRows = null;
    // The unit of the certificate table in use, as the certificate
    // gives it — for a layout's headings when it is one this page
    // can't convert.
    let scopeUnit = '';
    const tableSelect = tq('table-select');
    const uutUnitRow = tq('uut-unit-row');
    const uutUnitSelect = tq('uut-unit-select');
    const uutUnitNote = tq('uut-unit-note');
    const stageBoxes = { before: tq('stage-before'), after: tq('stage-after') };
    const tolTypeSelect = tq('tol-type');
    const tolPctInput = tq('tol-pct');
    const tolPctRow = tq('tol-pct-row');
    const tolFsInput = tq('tol-fs');
    const tolFsRow = tq('tol-fs-row');
    const tolAddInput = tq('tol-add');
    const labRdgHeader = tq('lab-rdg-header');
    const uutRdgHeader = tq('uut-rdg-header');
    const interpTbody = tq('interp-tbody');
    const addRowBtn = tq('add-row');

    // currentPoints: [{x, y}], sorted ascending by x, de-duplicated — the
    // chosen reference table's points with x (Lab Rdg) converted into
    // the selected UUT unit; y (Correction) is always left as recorded
    // on the certificate. [] when nothing's selected.
    let currentPoints = [];
    // activeUnitInfo describes the reference table currently in play:
    // nativeUnit/category as detected from table.unit, plus rawPoints —
    // the same points as currentPoints but with x still in the
    // certificate's original unit, so switching the UUT unit dropdown can
    // re-derive currentPoints without re-reading the table.
    let activeUnitInfo = { nativeUnit: null, category: null };
    let rawPoints = [];
    // Whether these readings were taken before the UUT was adjusted or
    // after — "as found" and "as left". ADJUST_STAGES (history.js) has
    // the values. It is always one or the other, and "before" unless
    // "after" has been chosen: that's what a first set of readings is.
    // So a table that comes with no mark — new, saved when a table
    // could be left unmarked, or from a layout that has no use for
    // one — is "before".
    let stage = tableState && ADJUST_STAGES[tableState.stage] ? tableState.stage : 'before';
    // A layout with before-adjust and after-adjust columns in each row
    // has no use for a mark on the table as a whole.
    if (form && !form.stage) stage = '';
    let title = '';
    // Folded away, a table is its heading and a line of what's in it.
    let folded = Boolean(tableState && tableState.collapsed);

    // The certificate these readings are corrected by: one of those
    // held for the worksheet's equipment, by its number (null: none
    // chosen). By number, not by its place in the list — that moves as
    // scans are added, and the scan itself can go missing and come back.
    let selectedCert = null;
    // The certificate numbers the picker's options stand for, in order.
    let certOptions = [];

    function certEntry() {
      return selectedCert === null ? null : certificateEntry(selectedCert);
    }

    // One option per certificate held for the equipment, those on its
    // latest label first. One past its due date is listed but can't be
    // picked — except by the table that is already on it, which is how
    // a worksheet stays tied to the certificate it was made with. Like
    // the scope picker below, it is there even with one to pick from:
    // it is also what says which certificate this table is read against.
    function populateCertSelect() {
      const certificates = equipmentCertificates();
      certSelect.innerHTML = '';
      certOptions = certificates.map((entry) => entry.cert);
      if (certificates.length === 0) {
        certSelect.appendChild(el('option', null, selectedEquipmentId === null ? '— Select equipment first —' : 'No certificate among the scans')).value = '';
        certSelect.disabled = true;
        return;
      }
      certSelect.disabled = false;
      const mineIndex = certOptions.indexOf(selectedCert);
      if (mineIndex < 0) certSelect.appendChild(el('option', null, '— Select —')).value = '';
      certificates.forEach((entry, index) => {
        const due = isCalibrationDue(entry.due);
        const opt = el('option', null, `${entry.cert || '(no certificate no.)'}${due ? ' (calibration due)' : ''}`);
        opt.value = String(index);
        opt.disabled = due && index !== mineIndex;
        certSelect.appendChild(opt);
      });
      certSelect.value = mineIndex < 0 ? '' : String(mineIndex);
    }

    // The picker is always there, even with one scope/unit table to
    // pick from — it's also what says which one this table is read
    // against.
    function populateTableSelect(entry) {
      tableSelect.innerHTML = '';
      const scopeTables = entry && Array.isArray(entry.tables) ? entry.tables : [];
      if (scopeTables.length === 0) {
        const why = entry ? 'No tables in this certificate' : selectedEquipmentId === null ? '— Select equipment first —' : '— Select a certificate first —';
        tableSelect.appendChild(el('option', null, why)).value = '';
        tableSelect.disabled = true;
        return;
      }
      tableSelect.disabled = false;
      scopeTables.forEach((table, index) => {
        const label = [table.scope, table.unit].filter(Boolean).join(' · ') || `Table ${index + 1}`;
        const opt = el('option', null, label);
        opt.value = String(index);
        tableSelect.appendChild(opt);
      });
    }
    // Rebuilds the UUT unit dropdown for the currently selected reference
    // table. Only Pressure, Temperature, Current and Voltage units are
    // supported — anything else (or a table.unit we don't recognize)
    // disables the dropdown and falls back to using Lab Rdg exactly as
    // recorded on the certificate.
    function populateUutUnitSelect(table) {
      uutUnitSelect.innerHTML = '';
      const nativeUnit = table ? normalizeUnit(table.unit) : null;
      const category = nativeUnit ? unitCategory(nativeUnit) : null;
      activeUnitInfo = { nativeUnit, category };

      if (!table) {
        uutUnitRow.classList.add('hidden');
        return;
      }

      if (!category) {
        uutUnitSelect.appendChild(el('option', null, 'No conversion available')).value = '';
        uutUnitSelect.disabled = true;
        uutUnitRow.classList.remove('hidden');
        uutUnitNote.classList.remove('hidden');
        return;
      }

      uutUnitNote.classList.add('hidden');
      uutUnitRow.classList.remove('hidden');
      uutUnitSelect.disabled = false;
      const units = UNITS_BY_CATEGORY[category] || [];
      units.forEach((unit) => {
        const opt = el('option', null, unit);
        opt.value = unit;
        uutUnitSelect.appendChild(opt);
      });
      // Default to the certificate's own unit — no conversion until the
      // user deliberately picks a different UUT unit.
      uutUnitSelect.value = nativeUnit;
    }

    // Re-derives currentPoints (and the Lab Rdg/UUT Rdg column headers)
    // from rawPoints + the currently selected UUT unit. Correction (y) is
    // never touched here — only Lab Rdg (x) moves between units. UUT Rdg
    // is measured directly in the selected UUT unit (that's the whole
    // point of the dropdown), so its header tracks the same targetUnit.
    function applyUnitConversion() {
      const targetUnit = uutUnitSelect.value || activeUnitInfo.nativeUnit;
      if (activeUnitInfo.category && targetUnit) {
        currentPoints = rawPoints.map((p) => ({
          x: convertUnit(p.x, activeUnitInfo.nativeUnit, targetUnit, activeUnitInfo.category),
          y: p.y,
        }));
        labRdgHeader.textContent = `Lab Rdg (${targetUnit})`;
        uutRdgHeader.textContent = `UUT Rdg (${targetUnit})`;
      } else {
        currentPoints = rawPoints;
        labRdgHeader.textContent = 'Lab Rdg';
        uutRdgHeader.textContent = 'UUT Rdg';
      }
      if (formRows) formRows.setHead();
    }

    // The unit a layout's headings give: the one readings are converted
    // to, or the certificate's own where there is no converting.
    function tableUnit() {
      return (activeUnitInfo.category ? uutUnitSelect.value || activeUnitInfo.nativeUnit : scopeUnit) || '';
    }

    function recomputeRows() {
      Array.from(interpTbody.children).forEach((tr) => tr._recompute && tr._recompute());
    }

    // Points this table at its certificate's scope/unit tables.
    // populateTableSelect rebuilds the <option>s from scratch every call,
    // which — with no option marked selected — the browser defaults back
    // to the first. That's correct when the CERTIFICATE just changed (a
    // fresh scope list, start from its first table), but wrong for a
    // same-certificate call — the scope picker's own 'change' handler, or
    // the restore path re-applying a saved tableIndex — where the whole
    // point is to land on a SPECIFIC table. Those pass preserveSelection
    // so the just-set value survives the rebuild.
    function refresh(preserveSelection) {
      const entry = certEntry();
      const preservedIndex = tableSelect.value;
      populateTableSelect(entry);
      let table = null;
      if (entry) {
        if (preserveSelection && preservedIndex !== '' && entry.tables && entry.tables[Number(preservedIndex)]) {
          tableSelect.value = preservedIndex;
        }
        const tableIndex = tableSelect.value !== '' ? Number(tableSelect.value) : 0;
        table = (entry.tables || [])[tableIndex] || null;
      }
      rawPoints = getSortedPoints(table);
      scopeUnit = (table && table.unit) || '';
      populateUutUnitSelect(table);
      applyUnitConversion();
      recomputeRows();
    }

    // Reads the table against another certificate (null: none), from
    // that certificate's first scope/unit table.
    function useCertificate(cert) {
      selectedCert = cert;
      populateCertSelect();
      refresh(false);
    }

    certSelect.addEventListener('change', () => {
      useCertificate(certSelect.value !== '' ? certOptions[Number(certSelect.value)] : null);
      onChange();
    });
    // A scan made just now only lands in history at that moment, so the
    // option list is refreshed right before the dropdown opens.
    certSelect.addEventListener('mousedown', () => populateCertSelect());
    certSelect.addEventListener('focus', () => populateCertSelect());
    tableSelect.addEventListener('change', () => { refresh(true); onChange(); });    uutUnitSelect.addEventListener('change', () => {
      applyUnitConversion();
      recomputeRows();
      onChange();
    });

    // Two checkboxes, exactly one ticked: ticking one unticks the other,
    // and unticking "After adjust" goes back to "Before adjust" (which
    // can't itself be unticked — there is nothing else to go back to).
    function syncStage() {
      Object.entries(stageBoxes).forEach(([value, box]) => {
        box.checked = stage === value;
      });
      section.dataset.stage = stage;
      stageChip.textContent = ADJUST_STAGES[stage] || '';
      stageChip.className = `stage-chip${stage ? ` stage-chip-${stage}` : ' hidden'}`;
      if (formRows) formRows.setHead();
    }
    Object.entries(stageBoxes).forEach(([value, box]) => {
      box.addEventListener('change', () => {
        stage = box.checked ? value : 'before';
        syncStage();
        onChange();
      });
    });

    // --- Accuracy (± % rdg + fixed / ± % FS + fixed / ± fixed) ---
    // The tolerance this table's readings are judged against. It's the
    // table's own, not the worksheet's: one UUT is often tested over
    // several scopes, each with a different stated accuracy. In the code
    // (and the tol* fields in saved worksheets and records) it keeps the
    // word it was built under, "tolerance".
    // "% rdg" is a percentage of Act Lab Rdg (the reference/lab value at
    // that test point), not the UUT's own reading. Fixed is added on top
    // for both percent types, and is the whole tolerance for "± fixed".
    // A blank Percent or Fixed counts as zero, so either one alone is a
    // tolerance. toleranceLimit() below returns null — and the row stays
    // uncolored rather than reading as a false pass or fail — only when
    // there's nothing to judge by: both blank, or a percent of full scale
    // with no Full scale entered.
    // The three figures take a number and nothing else, never negative
    // (history.js's restrictInput) — set up ahead of the listeners below
    // so those only see the cleaned text.
    [tolPctInput, tolFsInput, tolAddInput].forEach((input) => {
      restrictInput(input, (text) => cleanNumberText(text, false));
    });

    function updateToleranceVisibility() {
      const type = tolTypeSelect.value;
      tolPctRow.classList.toggle('hidden', type === 'fixed');
      tolFsRow.classList.toggle('hidden', type !== 'pct_fs_add');
    }

    function toleranceLimit(actLabRdg) {
      const type = tolTypeSelect.value;
      const add = parseFloat(tolAddInput.value);
      const pct = type === 'fixed' ? NaN : parseFloat(tolPctInput.value);
      if (!Number.isFinite(add) && !Number.isFinite(pct)) return null;
      let limit = Number.isFinite(add) ? Math.abs(add) : 0;
      if (Number.isFinite(pct)) {
        const base = type === 'pct_fs_add' ? parseFloat(tolFsInput.value) : actLabRdg;
        if (!Number.isFinite(base)) return null;
        limit += (Math.abs(pct) / 100) * Math.abs(base);
      }
      return limit;
    }

    tolTypeSelect.addEventListener('change', () => {
      updateToleranceVisibility();
      recomputeRows();
      onChange();
    });
    [tolPctInput, tolFsInput, tolAddInput].forEach((input) => {
      input.addEventListener('input', () => {
        recomputeRows();
        onChange();
      });
    });

    // --- Interpolation + row math ---

    function interpolateCorrection(labRdg) {
      if (!Number.isFinite(labRdg)) return { value: null, error: null };
      if (currentPoints.length === 0) return { value: null, error: 'No reference data selected' };

      const minX = currentPoints[0].x;
      const maxX = currentPoints[currentPoints.length - 1].x;
      if (labRdg < minX || labRdg > maxX) {
        return { value: null, error: `Out of range (${formatNumber(minX)}–${formatNumber(maxX)})` };
      }

      const exact = currentPoints.find((p) => p.x === labRdg);
      if (exact) return { value: exact.y, error: null };

      for (let i = 0; i < currentPoints.length - 1; i += 1) {
        const a = currentPoints[i];
        const b = currentPoints[i + 1];
        if (labRdg >= a.x && labRdg <= b.x) {
          const t = (labRdg - a.x) / (b.x - a.x);
          return { value: a.y + t * (b.y - a.y), error: null };
        }
      }
      return { value: null, error: 'Could not interpolate' };
    }

    function addRow(labRdgValue, uutRdgValue, photoIds) {
      const tr = document.createElement('tr');

      const labRdgInput = document.createElement('input');
      labRdgInput.type = 'text';
      labRdgInput.inputMode = 'decimal';
      labRdgInput.placeholder = 'Lab rdg';
      // One number, which can be below zero.
      restrictInput(labRdgInput, (text) => cleanNumberText(text, true));
      if (labRdgValue) labRdgInput.value = labRdgValue;
      const labRdgTd = el('td');
      labRdgTd.appendChild(labRdgInput);

      const correctionTd = el('td', 'interp-computed', '—');
      const actLabTd = el('td', 'interp-computed', '—');

      const uutInput = document.createElement('input');
      uutInput.type = 'text';
      // The number keypad, as for Lab rdg. It has no letters to type in
      // the first place, and still has what several readings are kept
      // apart with — a comma or a space.
      uutInput.inputMode = 'decimal';
      uutInput.placeholder = 'UUT rdg';
      // Numbers only, but more than one of them — see parseUutAverage.
      restrictInput(uutInput, cleanReadingsText);
      if (uutRdgValue) uutInput.value = uutRdgValue;
      const uutTd = el('td');
      uutTd.appendChild(uutInput);

      const correctionRdgTd = el('td', 'interp-computed', '—');

      const removeBtn = el('button', 'interp-row-remove');
      removeBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>';
      removeBtn.type = 'button';
      removeBtn.title = 'Remove row';

      const photoBtn = el('button', 'interp-row-photo');
      photoBtn.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.5"/></svg>';
      photoBtn.type = 'button';
      photoBtn.title = 'Add a photo of this reading';
      photoBtn.setAttribute('aria-label', 'Add a photo of this reading');

      const removeTd = el('td', 'interp-row-actions');
      removeTd.append(photoBtn, removeBtn);

      // The photos taken of this reading (photos.js), by id — kept on the
      // row itself, like _recompute below, so collectRowsData() and Save
      // read them from the same place they read the inputs. Each shows as
      // a thumbnail under the row; opening one offers to delete it.
      const photosTd = el('td', 'interp-row-photos');
      tr._photos = [];

      function addRowPhoto(photoId, dataUrl) {
        tr._photos.push(photoId);
        const thumb = buildPhotoThumb(photoId, () => {
          tr._photos = tr._photos.filter((p) => p !== photoId);
          thumb.remove();
          onChange();
          deleteUnusedPhotos([photoId]);
        }, dataUrl);
        photosTd.appendChild(thumb);
      }
      (Array.isArray(photoIds) ? photoIds : []).forEach((photoId) => addRowPhoto(photoId));

      photoBtn.addEventListener('click', () => {
        capturePhoto((photoId, dataUrl) => {
          // The row (or its table) was removed while the camera was
          // open — nothing left to attach the photo to.
          if (!tr.isConnected) {
            deletePhoto(photoId);
            return;
          }
          addRowPhoto(photoId, dataUrl);
          onChange();
        });
      });

      // The photos cell goes on the end: the first six keep the positions
      // style.css (nth-child) and collectRowsData() know them by.
      tr.append(labRdgTd, correctionTd, actLabTd, uutTd, correctionRdgTd, removeTd, photosTd);
      interpTbody.appendChild(tr);

      function recompute() {
        const labRdg = parseFloat(labRdgInput.value);
        const { value: labCorrection, error } = interpolateCorrection(labRdg);

        if (error) {
          correctionTd.textContent = error;
          correctionTd.classList.add('cell-error');
        } else {
          correctionTd.textContent = labCorrection !== null ? formatNumber(labCorrection) : '—';
          correctionTd.classList.remove('cell-error');
        }

        const actLab = Number.isFinite(labRdg) && labCorrection !== null ? labRdg + labCorrection : null;
        actLabTd.textContent = actLab !== null ? formatNumber(actLab) : '—';

        const avgUut = parseUutAverage(uutInput.value);
        // Correction Rdg is given to the UUT's own scale resolution — the
        // nearest step of it — once that's been entered, rather than to
        // however many decimals the arithmetic produces. It's that
        // figure, the one shown, that's judged against the accuracy
        // below, so what's on the page and its verdict always agree.
        // (To 9 places first, to shed the arithmetic's floating tail.)
        const exactCorrection = actLab !== null && avgUut !== null ? actLab - avgUut : null;
        const resolution = parseResolution(uutResolutionInput.value);
        let correctionRdg = exactCorrection;
        let correctionText = exactCorrection !== null ? formatNumber(exactCorrection) : '—';
        if (exactCorrection !== null && resolution) {
          correctionText = snapToResolution(Number(exactCorrection.toFixed(9)), resolution);
          correctionRdg = Number(correctionText);
        }
        correctionRdgTd.textContent = correctionText;

        // Out of tolerance marks the whole row red — tint, edge bar and a
        // label beside the Correction Rdg that's over the limit — along
        // with the UUT reading that put it there. A row that's within
        // tolerance gets a green edge; one with nothing to judge by, none.
        correctionRdgTd.classList.remove('tol-pass', 'tol-fail');
        let outOfTolerance = false;
        if (correctionRdg !== null) {
          const limit = toleranceLimit(actLab);
          if (limit !== null) {
            // The margin is for the arithmetic, not the tolerance: a
            // correction that is exactly the limit can come out of the
            // subtraction a hair over it (55.475 − 55.275 isn't quite 0.2).
            outOfTolerance = Math.abs(correctionRdg) > limit + 1e-9;
            correctionRdgTd.classList.add(outOfTolerance ? 'tol-fail' : 'tol-pass');
          }
        }
        uutInput.classList.toggle('tol-fail', outOfTolerance);
        tr.classList.toggle('row-tol-fail', outOfTolerance);
        tr.classList.toggle('row-tol-pass', correctionRdgTd.classList.contains('tol-pass'));
      }

      function handleRowInput() {
        recompute();
        onChange();
      }

      // Rewrites the UUT Rdg as something the UUT could actually show:
      // the nearest multiple of its scale resolution — under an SR of
      // 0.02, "57.03" becomes "57.04" and "59" becomes "59.00". Nothing
      // happens while SR is blank or isn't a number.
      function applyResolution() {
        const resolution = parseResolution(uutResolutionInput.value);
        if (!resolution) return;
        const formatted = snapReadings(uutInput.value, resolution);
        if (formatted === uutInput.value) return;
        uutInput.value = formatted;
        recompute();
      }

      labRdgInput.addEventListener('input', handleRowInput);
      uutInput.addEventListener('input', handleRowInput);
      // Once the reading has been keyed in and the box left — not while
      // typing, which would fight the cursor.
      uutInput.addEventListener('change', () => {
        applyResolution();
        onChange();
      });
      tr._applyResolution = applyResolution;
      removeBtn.addEventListener('click', () => {
        const rowPhotos = tr._photos.slice();
        tr.remove();
        onChange();
        deleteUnusedPhotos(rowPhotos);
      });

      tr._recompute = recompute;
      recompute();
    }

    addRowBtn.addEventListener('click', () => {
      if (formRows) formRows.addRow(null);
      else addRow();
      onChange();
    });
    fnInput.addEventListener('input', () => onChange());

    function collectRowsData() {
      if (formRows) return formRows.collect();
      return Array.from(interpTbody.children).map((tr) => ({
        labRdg: tr.children[0].querySelector('input').value,
        uutRdg: tr.children[3].querySelector('input').value,
        photos: tr._photos.slice(),
      }));
    }

    function tableVerdicts() {
      const rows = Array.from(interpTbody.children);
      const failed = rows.filter((tr) => tr.classList.contains('row-tol-fail')).length;
      return { judged: failed + rows.filter((tr) => tr.classList.contains('row-tol-pass')).length, failed };
    }

    function syncFold() {
      section.classList.toggle('section-collapsed', folded);
      foldBtn.setAttribute('aria-expanded', String(!folded));
      if (!folded) {
        foldSummary.textContent = '';
        return;
      }
      const readings = collectRowsData().filter((row) => !isBlankRow(row)).length;
      const { failed } = tableVerdicts();
      const scope = tableSelect.value !== '' ? tableSelect.options[tableSelect.selectedIndex].textContent : '';
      // Which certificate, only where the equipment has more than one.
      const cert = selectedCert && certOptions.length > 1 ? selectedCert : '';
      foldSummary.textContent = [cert, scope, `${readings} reading${readings === 1 ? '' : 's'}`, failed > 0 ? `${failed} out of tolerance` : ''].filter(Boolean).join(' · ');
    }
    foldBtn.addEventListener('click', () => {
      folded = !folded;
      onChange();
    });

    const api = {
      el: section,
      useCertificate,
      // The equipment's list of certificates may have changed (a scan
      // just made); which one this table is on has not.
      refreshCertificates() {
        populateCertSelect();
        refresh(true);
      },
      getCertificate() {
        return selectedCert;
      },
      // Nothing entered yet: no reading, no photo.
      isBlank() {
        return collectRowsData().every(isBlankRow);
      },
      recompute: recomputeRows,
      getVerdicts: tableVerdicts,
      refreshSummary: syncFold,
      applyResolution() {
        Array.from(interpTbody.children).forEach((tr) => tr._applyResolution && tr._applyResolution());
      },
      // "Table N" — and no remove button on a worksheet's only table.
      setNumber(number, total) {
        title = `Table ${number}`;
        titleEl.textContent = title;
        removeTableBtn.classList.toggle('hidden', total < 2);
      },
      getTitle() {
        return title;
      },
      getState() {
        return {
          cert: selectedCert,
          tableIndex: tableSelect.value !== '' ? Number(tableSelect.value) : 0,
          uutUnit: uutUnitSelect.value || null,
          stage,
          tolType: tolTypeSelect.value,
          tolPct: tolPctInput.value,
          tolFs: tolFsInput.value,
          tolAdd: tolAddInput.value,
          collapsed: folded,
          fn: fnInput.value,
          rows: collectRowsData(),
        };
      },
      // This table as a saved record keeps it: the computed columns as
      // currently displayed, and what it was read against in words
      // rather than as an index into a certificate that may change.
      // Blank rows (no Lab Rdg, no UUT Rdg and no photo) are dropped — a
      // placeholder row isn't data worth keeping.
      getRecord() {
        const scopeOption = tableSelect.value !== '' ? tableSelect.options[tableSelect.selectedIndex] : null;
        // A layout's table is kept whole — headings and every cell — in
        // `form`, beside rows that say of each what a row of the
        // simple table says.
        const snapshot = formRows ? formRows.record() : null;
        const rows = snapshot ? snapshot.rows : Array.from(interpTbody.children)
          .map((tr) => ({
            labRdg: tr.children[0].querySelector('input').value,
            labCorrectionRdg: tr.children[1].textContent,
            actLabRdg: tr.children[2].textContent,
            uutRdg: tr.children[3].querySelector('input').value,
            correctionRdg: tr.children[4].textContent,
            photos: tr._photos.slice(),
            outOfTolerance: tr.classList.contains('row-tol-fail'),
          }))
          .filter((r) => r.labRdg.trim() !== '' || r.uutRdg.trim() !== '' || r.photos.length > 0);
        const entry = certEntry();
        return {
          // The certificate it was read against, and the two things
          // about it a record shows, as they stood when this was saved.
          cert: selectedCert,
          certDue: entry ? entry.due || null : null,
          certTrace: entry ? entry.trace || null : null,
          // Which of that certificate's tables it was, for a record opened
          // again as a worksheet; the label is for everything else.
          tableIndex: tableSelect.value !== '' ? Number(tableSelect.value) : null,
          scopeUnitLabel: scopeOption ? scopeOption.textContent : null,
          uutUnit: uutUnitSelect.value || null,
          stage,
          tolType: tolTypeSelect.value,
          tolPct: tolPctInput.value || null,
          tolFs: tolFsInput.value || null,
          tolAdd: tolAddInput.value || null,
          labRdgHeader: labRdgHeader.textContent,
          uutRdgHeader: uutRdgHeader.textContent,
          rows,
          ...(snapshot ? { form: snapshot.form, fn: (form.fn && fnInput.value.trim()) || null } : {}),
        };
      },
    };

    removeTableBtn.addEventListener('click', () => removeTable(api));

    // --- Restore this table's saved state (or start blank) ---
    // Against whatever equipment the worksheet is on at this moment.
    // A new table's accuracy starts as "± fixed", the commonest kind.
    // The kind is only what was saved if figures were saved with it: a
    // table whose accuracy was never filled in shows the default,
    // whatever kind it happened to be left on.
    const accuracyEntered = tableState && (tableState.tolPct || tableState.tolFs || tableState.tolAdd);
    tolTypeSelect.value = (accuracyEntered && tableState.tolType) || 'fixed';
    if (tolTypeSelect.value === '') tolTypeSelect.value = 'fixed';
    tolPctInput.value = (tableState && tableState.tolPct) || '';
    tolFsInput.value = (tableState && tableState.tolFs) || '';
    tolAddInput.value = (tableState && tableState.tolAdd) || '';
    updateToleranceVisibility();
    fnInput.value = (tableState && tableState.fn) || '';
    fnRow.classList.toggle('hidden', !(form && form.fn));
    stageRow.classList.toggle('hidden', Boolean(form) && !form.stage);
    if (form) {
      // With this many columns the rows are what the eye is on, and a
      // reading is added where the last one ends: the button goes
      // under the table instead of over it.
      const footer = el('div', 'reading-table-footer');
      footer.appendChild(addRowBtn);
      section.appendChild(footer);
      formRows = createFormRows({
        form,
        table: section.querySelector('table'),
        env: {
          cf: (reading) => interpolateCorrection(reading),
          limit: (reference) => toleranceLimit(reference),
          resolution: () => parseResolution(uutResolutionInput.value),
          unit: tableUnit,
          stage: () => stage,
          onChange: () => onChange(),
        },
      });
    }
    syncStage();
    // Its certificate: the one it was saved with; for a table from before
    // tables chose their own, the one the worksheet had; for a table
    // that is new, the newest the equipment has that is still good.
    if (tableState && tableState.cert !== undefined) selectedCert = tableState.cert;
    else selectedCert = inheritedCert !== null ? inheritedCert : defaultCertificate();
    populateCertSelect();
    refresh(false);
    if (tableState && tableState.tableIndex != null && !tableSelect.disabled && tableSelect.options[tableState.tableIndex]) {
      tableSelect.value = String(tableState.tableIndex);
      refresh(true);
    }
    if (tableState && tableState.uutUnit && !uutUnitSelect.disabled) {
      uutUnitSelect.value = tableState.uutUnit;
      applyUnitConversion();
    }
    const savedRows = !madeOver && tableState && Array.isArray(tableState.rows) && tableState.rows.length > 0 ? tableState.rows : null;
    if (savedRows) {
      savedRows.forEach((r) => (formRows ? formRows.addRow(r) : addRow(r.labRdg, r.uutRdg, r.photos)));
    } else if (formRows) {
      for (let i = 0; i < FORM_DEFAULT_ROWS; i += 1) formRows.addRow(null);
    } else {
      for (let i = 0; i < DEFAULT_ROW_COUNT; i += 1) addRow();
    }

    return api;
  }

  // --- Tables side by side ---
  // A worksheet's tables are in a row, each the width of the page, and
  // are swiped between: left for the next, right for the one before,
  // snapping into place (style.css does that). The bar over them says
  // which is showing, with a dot per table and arrows for where there
  // is nothing to swipe with — a mouse.

  // The table that is showing: the one whose left edge is nearest the
  // row's own.
  function showingIndex() {
    if (tables.length === 0) return 0;
    const edge = tablesEl.getBoundingClientRect().left;
    let nearest = 0;
    tables.forEach((table, index) => {
      if (Math.abs(table.el.getBoundingClientRect().left - edge) < Math.abs(tables[nearest].el.getBoundingClientRect().left - edge)) nearest = index;
    });
    return nearest;
  }
  function showTable(index) {
    const table = tables[Math.max(0, Math.min(tables.length - 1, index))];
    if (!table) return;
    tablesEl.scrollTo({ left: table.el.getBoundingClientRect().left - tablesEl.getBoundingClientRect().left + tablesEl.scrollLeft, behavior: 'smooth' });
  }

  function syncPager() {
    pagerEl.classList.toggle('hidden', tables.length < 2);
    // The row is as tall as the table that is showing, not as the
    // tallest of them, so what follows sits right under it.
    tablesEl.style.height = tables.length > 0 ? `${tables[showingIndex()].el.offsetHeight}px` : '';
    if (tables.length === 0) return;
    const showing = showingIndex();
    const mark = ADJUST_STAGES[tables[showing] && tables[showing].el.dataset.stage];
    pagerLabel.textContent = `Table ${showing + 1} of ${tables.length}${mark ? ` · ${mark}` : ''}`;
    pagerPrev.disabled = showing === 0;
    pagerNext.disabled = showing === tables.length - 1;
    if (pagerDots.children.length !== tables.length) {
      pagerDots.innerHTML = '';
      tables.forEach((table, index) => {
        const dot = el('button', 'table-pager-dot');
        dot.type = 'button';
        dot.setAttribute('aria-label', `Table ${index + 1}`);
        dot.addEventListener('click', () => showTable(index));
        pagerDots.appendChild(dot);
      });
    }
    Array.from(pagerDots.children).forEach((dot, index) => dot.classList.toggle('active', index === showing));
  }

  pagerPrev.addEventListener('click', () => showTable(showingIndex() - 1));
  pagerNext.addEventListener('click', () => showTable(showingIndex() + 1));
  // Swiping is the row scrolling; the bar follows it once a frame.
  let pagerFrame = null;
  tablesEl.addEventListener('scroll', () => {
    if (pagerFrame !== null) return;
    pagerFrame = requestAnimationFrame(() => {
      pagerFrame = null;
      syncPager();
    });
  });
  // A table grows and shrinks (a reading added, a photo loaded, a fold),
  // and the screen can be turned: the row's height follows.
  const pagerSizes = window.ResizeObserver ? new ResizeObserver(() => syncPager()) : null;
  if (pagerSizes) pagerSizes.observe(tablesEl);

  function renumberTables() {
    tables.forEach((table, index) => table.setNumber(index + 1, tables.length));
  }

  function addTable(tableState) {
    const table = createReadingTable(tableState);
    tables.push(table);
    tablesEl.appendChild(table.el);
    if (pagerSizes) pagerSizes.observe(table.el);
    renumberTables();
    return table;
  }

  function removeTable(table) {
    if (tables.length < 2) return;
    if (!window.confirm(`Remove ${table.getTitle()} and its readings?`)) return;
    const photoIds = rowPhotoIds(table.getState().rows);
    tables.splice(tables.indexOf(table), 1);
    table.el.remove();
    renumberTables();
    onChange();
    // After the change is saved, so photos only this table held are
    // seen as let go of.
    deleteUnusedPhotos(photoIds);
  }

  // --- Type of worksheet ---
  // The picker is there when Settings has the page set to "Worksheet",
  // and lists the official worksheets only: Settings is the one switch
  // between those and an unofficial record. A worksheet that is still
  // a simple table then (it had readings when Settings was changed)
  // is shown as having none chosen yet. Changing the type rebuilds
  // every table in the new layout: each keeps its setup, its photos,
  // and the readings the new layout has a column for.
  if (worksheetType === '') typeSelect.appendChild(el('option', null, '— Choose a type —')).value = '';
  WORKSHEET_FORMS.forEach((form) => {
    typeSelect.appendChild(el('option', null, form.name)).value = form.id;
  });
  typeSelect.value = worksheetType;
  typeRow.classList.toggle('hidden', !worksheetMode);
  typeSelect.addEventListener('change', () => {
    const hasReadings = tables.some((table) => !table.isBlank());
    if (hasReadings && !window.confirm('Change the type of this worksheet?\n\nIts tables are laid out again for the new type. Readings that have no column in it are dropped.')) {
      typeSelect.value = worksheetType;
      return;
    }
    const states = tables.map((table) => table.getState());
    tables.splice(0).forEach((table) => table.el.remove());
    worksheetType = typeSelect.value;
    try {
      if (worksheetType) localStorage.setItem(LAST_WORKSHEET_TYPE_KEY, worksheetType);
    } catch {
      // Not remembered for the next new worksheet; nothing else is lost.
    }
    states.forEach((state) => addTable(state));
    // A type has been chosen: "none chosen yet" is no longer on offer.
    if (worksheetType !== '' && typeSelect.options[0].value === '') typeSelect.remove(0);
    onChange();
  });

  // A new table starts as a copy of the last one's setup — its
  // certificate, scope/unit table, UUT unit and accuracy — since the
  // usual reason for a second table is the same readings again after
  // adjusting, and all of it can be changed for a table that's another
  // scope or another certificate. Like any new table, it starts as
  // "before adjust".
  addTableBtn.addEventListener('click', () => {
    const last = tables[tables.length - 1].getState();
    const table = addTable({
      cert: last.cert,
      tableIndex: last.tableIndex,
      uutUnit: last.uutUnit,
      tolType: last.tolType,
      tolPct: last.tolPct,
      tolFs: last.tolFs,
      tolAdd: last.tolAdd,
    });
    onChange();
    table.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  function getState() {
    return {
      equipmentId: selectedEquipmentId,
      uutModel: uutModelInput.value,
      uutSerial: uutSerialInput.value,
      uutTag: uutTagInput.value,
      uutMaker: uutMakerInput.value,
      uutRange: uutRangeInput.value,
      uutResolution: uutResolutionInput.value,
      remarks: remarksInput.value,
      calDate: calDateInput.value,
      technician: technicianInput.value,
      ambientTemp: ambientTempInput.value,
      ambientHumidity: ambientHumidityInput.value,
      savedAtLeastOnce: hasSavedRecord,
      recordId,
      worksheetType,
      collapsed: Array.from(foldedSections),
      tables: tables.map((table) => table.getState()),
    };
  }

  // --- Save (writes to the UUT database — see database.html) ---
  // A snapshot, not a live reference: each table is captured as it reads
  // right now (see getRecord above) rather than re-derived later, so the
  // record stays meaningful even if this equipment's certificate changes
  // on a future scan. A table with no readings in it is left out.
  function buildSavedRecord() {
    const allTables = tables.map((table) => table.getRecord());
    const savedTables = allTables.filter((table) => table.rows.length > 0);

    // The certificates the record rests on: those its tables were read
    // against, each once, in table order (with no readings anywhere,
    // those of every table). Each table keeps its own; the record as a
    // whole names them all, for the Records page's list, search and
    // Reference Info — one certificate as it always has, several as
    // "A, B", with the certificate each due date or traceability
    // belongs to given beside it where they differ.
    const used = [];
    (savedTables.length > 0 ? savedTables : allTables).forEach((table) => {
      if (table.cert !== null && !used.some((u) => u.cert === table.cert)) used.push({ cert: table.cert, due: table.certDue, trace: table.certTrace });
    });
    const perCertificate = (key) => {
      const values = used.filter((u) => u[key]);
      if (values.length === 0) return null;
      if (used.length === 1 || (values.length === used.length && values.every((u) => u[key] === values[0][key]))) return values[0][key];
      return values.map((u) => `${u[key]} (${u.cert || 'no certificate no.'})`).join(', ');
    };

    return {
      savedAt: new Date().toISOString(),
      uutModel: uutModelInput.value || null,
      uutSerial: uutSerialInput.value || null,
      uutTag: uutTagInput.value || null,
      uutMaker: uutMakerInput.value || null,
      uutRange: uutRangeInput.value || null,
      uutResolution: uutResolutionInput.value || null,
      remarks: remarksInput.value.trim() || null,
      calDate: calDateInput.value || null,
      technician: technicianInput.value.trim() || null,
      ambientTemp: ambientTempInput.value || null,
      ambientHumidity: ambientHumidityInput.value || null,
      result: worksheetVerdict().result,
      worksheetType: worksheetType || null,
      equipmentId: selectedEquipmentId,
      equipmentCert: used.map((u) => u.cert).filter(Boolean).join(', ') || null,
      equipmentName: equipmentName() || null,
      equipmentDue: perCertificate('due'),
      equipmentTrace: perCertificate('trace'),
      tables: savedTables,
    };
  }
  function showSaveStatus(message, isError) {
    saveStatus.textContent = message;
    saveStatus.classList.remove('hidden');
    saveStatus.classList.toggle('save-status-error', Boolean(isError));
  }

  // The first Save adds a record to the Records page, under this
  // worksheet's customer folder. Every Save after that writes over that
  // same record — a correction doesn't leave the uncorrected one
  // beside it — unless "Save as a new record" is used, which adds a
  // separate one and makes that the one this worksheet goes on to
  // update. A record that's been deleted on the Records page in the
  // meantime is simply saved afresh.
  function saveRecord(asNew) {
    if (!uutModelInput.value.trim() && !uutSerialInput.value.trim()) {
      showSaveStatus('Enter a UUT Model and/or Serial No. before saving.', true);
      return;
    }
    const existing = asNew ? null : linkedRecord();
    // A record that's been moved to another customer folder on the
    // Records page stays where it was put.
    const filedUnder = existing
      ? { customerId: existing.customerId || null, customerName: existing.customerName || null }
      : tabCustomerFields(id);
    const record = { ...buildSavedRecord(), ...filedUnder };
    const label = formatUutLabel(record.uutModel, record.uutSerial);
    if (existing) {
      record.id = existing.id;
      const photosBefore = worksheetPhotoIds(existing);
      replaceUutRecord(existing.id, record);
      hasSavedRecord = true;
      onChange();
      // After the save: a photo the record had and no longer has, and
      // that nothing else uses, goes.
      deleteUnusedPhotos(photosBefore);
      showSaveStatus(`✓ Updated "${label}" on the Records page.`, false);
      return;
    }
    record.id = makeRecordId();
    recordId = record.id;
    addUutRecord(record);
    hasSavedRecord = true;
    onChange(); // persists the link to the record and refreshes this tab's chip label
    showSaveStatus(`✓ Saved as "${label}" — view it on the Records page.`, false);
  }

  saveBtn.addEventListener('click', () => saveRecord(false));
  saveNewBtn.addEventListener('click', () => saveRecord(true));
  // Takes a label just scanned into this tab — called by the shared
  // scanner above when this is the active tab. `scan` is what was read
  // from it. If it is other equipment than the worksheet was on, every
  // table is read against it from now: its first certificate that is
  // still good, and that certificate's first scope. If it is the same
  // equipment again (a new label, after a certificate was renewed),
  // only tables with nothing in them yet do that: a table that has
  // readings stays with the certificate they were worked out against,
  // and simply has the label's certificates added to its list.
  function selectEquipment(scan) {
    const sameEquipment = selectedEquipmentId === scan.id;
    selectedEquipmentId = scan.id;
    populateEquipmentSelect();
    renderEquipmentInfo();
    const scanned = scanCertificates(scan);
    const start = scanned.find((certificate) => !isCalibrationDue(certificate.due)) || scanned[0];
    tables.forEach((table) => {
      if (!sameEquipment || table.isBlank()) table.useCertificate(start ? start.cert : null);
      else table.refreshCertificates();
    });
    onChange();
  }
  // --- Restore this worksheet's saved state (or start blank) ---
  // Equipment is looked up by its ID against the live history rather
  // than trusting a stored dropdown index, since scans since the last
  // save could have shifted indices around.
  if (initialState && initialState.equipmentId != null) selectedEquipmentId = initialState.equipmentId;
  if (initialState) {
    uutModelInput.value = initialState.uutModel || '';
    uutSerialInput.value = initialState.uutSerial || '';
    uutTagInput.value = initialState.uutTag || '';
    uutMakerInput.value = initialState.uutMaker || '';
    uutRangeInput.value = initialState.uutRange || '';
    uutResolutionInput.value = initialState.uutResolution || '';
    remarksInput.value = initialState.remarks || '';
    ambientTempInput.value = initialState.ambientTemp || '';
    ambientHumidityInput.value = initialState.ambientHumidity || '';
    hasSavedRecord = Boolean(initialState.savedAtLeastOnce);
  }
  // A worksheet that has never had a date starts with today's; one
  // that has keeps what it had, blank included. The technician is the
  // one named in Settings until the worksheet says otherwise — which
  // covers a worksheet begun before that name was filled in — but a
  // record opened for editing keeps its own, blank or not.
  calDateInput.value = initialState && 'calDate' in initialState ? initialState.calDate || '' : todayDateValue();
  technicianInput.value = (initialState && initialState.technician) || (recordId ? '' : loadSettings().technician);
  populateEquipmentSelect();
  renderEquipmentInfo();

  // Each table restores itself against the equipment just selected. A
  // worksheet from before there could be more than one table kept its
  // rows, scope/unit table and UUT unit on the worksheet itself —
  // worksheetTables (history.js) reads that as the tables it'd be now,
  // and gives a table with no accuracy of its own the one the worksheet
  // had when accuracy was still set once for all of them.
  const savedTables = worksheetTables(initialState);
  if (savedTables.length > 0) savedTables.forEach((tableState) => addTable(tableState));
  else addTable(null);
  refreshSummaries();

  return {
    getState,
    selectEquipment,
    getRecordId: () => recordId,
  };
}

// --- A saved record, opened as a worksheet ---
// The Records page's Edit button (history.js's "Edit this record"
// handoff). A record is the worksheet as it read when saved, so it
// turns back into one: its details, and each table's inputs — the
// computed figures are worked out again from the reference data.
function recordToTabState(record) {
  // A table of a record from before tables kept their own certificate
  // was read against the record's one.
  const tableCert = (table) => (table.cert !== undefined ? table.cert : record.equipmentCert != null ? record.equipmentCert : null);
  const scopeLabels = (cert) => {
    const entry = heldCertificates(record.equipmentId).find((certificate) => certificate.cert === cert);
    return entry && Array.isArray(entry.tables) ? entry.tables.map((table, index) => [table.scope, table.unit].filter(Boolean).join(' · ') || `Table ${index + 1}`) : [];
  };
  return {
    recordId: record.id,
    savedAtLeastOnce: true,
    worksheetType: record.worksheetType || '',
    equipmentId: record.equipmentId,
    uutModel: record.uutModel || '',
    uutSerial: record.uutSerial || '',
    uutTag: record.uutTag || '',
    uutMaker: record.uutMaker || '',
    uutRange: record.uutRange || '',
    uutResolution: record.uutResolution || '',
    remarks: record.remarks || '',
    calDate: record.calDate || '',
    technician: record.technician || '',
    ambientTemp: record.ambientTemp || '',
    ambientHumidity: record.ambientHumidity || '',
    tables: worksheetTables(record).map((table) => ({
      cert: tableCert(table),
      // A record from before it kept the table's number is matched by
      // what the table was called.
      tableIndex: Number.isInteger(table.tableIndex) ? table.tableIndex : Math.max(0, scopeLabels(tableCert(table)).indexOf(table.scopeUnitLabel)),
      uutUnit: table.uutUnit || null,
      stage: ADJUST_STAGES[table.stage] ? table.stage : '',
      tolType: table.tolType,
      tolPct: table.tolPct,
      tolFs: table.tolFs,
      tolAdd: table.tolAdd,
      fn: table.fn || '',
      rows: (Array.isArray(table.rows) ? table.rows : []).map((row) => ({ labRdg: row.labRdg || '', uutRdg: row.uutRdg || '', photos: rowPhotoIds([row]), ...(row.v ? { v: row.v } : {}) })),
    })),
  };
}
// Goes to the worksheet a record is already open in, or opens it in a
// new one, in the record's customer folder.
function openRecordAsWorksheet(record) {
  const open = tabInstances.find((tab) => tab.api.getRecordId() === record.id);
  if (open) {
    setActiveCustomer(open.customerId);
    setActiveTab(open.id);
    return;
  }
  activeCustomerId = loadCustomers().some((c) => c.id === record.customerId) ? record.customerId : null;
  renderCustomerSelect();
  const state = recordToTabState(record);
  addTab(state);
  // Every certificate its tables were read against has to be among the
  // scans still, for the corrections to be worked out again.
  const missing = [];
  state.tables.forEach((table) => {
    const held = heldCertificates(record.equipmentId).some((certificate) => certificate.cert === table.cert);
    const name = table.cert || 'unknown';
    if (!held && !missing.includes(name)) missing.push(name);
  });
  if (record.equipmentId && missing.length > 0) {
    showScanStatus(`This record was made with ${record.equipmentId} (certificate ${missing.join(', ')}), which is no longer among the scans. Scan ${missing.length === 1 ? 'that certificate' : 'those certificates'} again before saving, or the corrections can't be worked out.`, true);
  }
}

// --- Boot: restore saved tabs, or start with one blank worksheet ---
// HISTORY_KEY is needed here too (not just TABS_STATE_KEY) — tab panels
// read the shared scan history synchronously via loadHistory() the
// moment they're created (createTabPanel populates the "Reference
// equipment" dropdown), so it has to already be hydrated by this point.
// SETTINGS_KEY is where a new worksheet gets its technician from.
// CUSTOMERS_KEY is the folders the tabs are filed under, and
// UUT_DATABASE_KEY is only read to know which reading photos a saved
// record still refers to (history.js's photoIdsInUse).

(async () => {
  await hydrateStorage([HISTORY_KEY, TABS_STATE_KEY, CUSTOMERS_KEY, UUT_DATABASE_KEY, SETTINGS_KEY]);
  ensureRecordIds();

  const savedTabsState = loadTabsState();
  const knownCustomerIds = new Set(loadCustomers().map((c) => c.id));
  if (savedTabsState && Array.isArray(savedTabsState.tabs) && savedTabsState.tabs.length > 0) {
    savedTabsState.tabs.forEach((tabState) => {
      const id = tabState.id || makeTabId();
      const root = tabTemplate.content.firstElementChild.cloneNode(true);
      root.classList.add('hidden');
      tabPanelsEl.appendChild(root);
      const api = createTabPanel(id, root, tabState, saveTabsState);
      // A folder that no longer exists leaves its worksheets unfiled.
      const customerId = knownCustomerIds.has(tabState.customerId) ? tabState.customerId : null;
      tabInstances.push({ id, root, chipEl: null, api, customerId });
    });
    const wantActive = tabInstances.find((t) => t.id === savedTabsState.activeTabId) || tabInstances[0];
    // The folder that opens is the one the last-used worksheet is in.
    activeCustomerId = wantActive.customerId;
    renderCustomerSelect();
    renderTabStrip();
    setActiveTab(wantActive.id);
  } else {
    renderCustomerSelect();
    addTab(null);
  }

  // --- Complete a "Use in a worksheet" handoff from the Scans page ---
  // See history.js's PENDING_WORKSHEET_EQUIP_KEY comment — opens a fresh
  // tab with that equipment pre-selected rather than touching whatever
  // tabs were already open.
  const pendingEquip = getPendingWorksheetEquip();
  if (pendingEquip && pendingEquip.equipmentId) {
    clearPendingWorksheetEquip();
    // The new worksheet's table starts on that scan's first certificate
    // that is still good.
    const scan = loadHistory().find((entry) => entry.id === pendingEquip.equipmentId && entry.cert === pendingEquip.equipmentCert);
    const start = scanCertificates(scan).find((certificate) => !isCalibrationDue(certificate.due));
    addTab({ equipmentId: pendingEquip.equipmentId, tables: start ? [{ cert: start.cert }] : undefined });
  }

  // --- Complete an "Edit" handoff from the Records page ---
  const pendingRecordId = getPendingWorksheetRecord();
  if (pendingRecordId) {
    clearPendingWorksheetRecord();
    const record = loadUutDatabase().find((r) => r && r.id === pendingRecordId);
    if (record) openRecordAsWorksheet(record);
  }
})();
