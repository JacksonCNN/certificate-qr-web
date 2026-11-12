// history.js — scan history and the storage layer under it, shared by
// scans.html (app.js lists it) and interpolate.html (interpolate.js
// writes to it after every successful decode and reads it as the
// reference-data picker). Plain globals, no bundler/module system —
// same pattern as jsQR/pako being loaded as plain <script> globals in
// this offline app. Nothing here ever leaves this device.

const HISTORY_KEY = 'certqr:history';

// --- Key/value store ---
// Scan history, the UUT database and worksheet tabs (the collections
// that can actually grow large) are saved as one .json file each in a
// storage folder — see "Storage folder" below. IndexedDB, right here,
// is what's left of the old browser-only storage: it's where data
// lives when there's no folder to write to (the pages opened straight
// from disk, or hosted somewhere without `npm run dev`'s API), and
// where data saved before the folder existed is picked up from.
// Settings-sized values (theme, sidebar state) stay in localStorage —
// see theme.js/sidebar.js — since those are read synchronously before
// first paint to avoid a flash of the wrong state, which an async read
// can't do.
const IDB_NAME = 'certqr';
const IDB_STORE = 'kv';
let idbOpenPromise = null;

function openIdb() {
  if (idbOpenPromise) return idbOpenPromise;
  idbOpenPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbOpenPromise;
}

function idbGet(key) {
  return openIdb().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function idbSet(key, value) {
  return openIdb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function idbDelete(key) {
  return openIdb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// --- Storage folder ---
// Each key is one file, named after the key without its "certqr:"
// prefix: history.json, uutDatabase.json, interpTabs.json, labLog.json,
// customers.json, shareLog.json, settings.json.
// Where the folder is depends on how the app is running:
//   - `npm run dev` on a PC: storage/ in the project folder, through
//     the dev server's /api/storage (vite.config.mjs) — a page in a
//     browser can't write files itself.
//   - the Android app: Documents/CertificateQR/storage on the phone,
//     through Capacitor's Filesystem plugin, next to the .json files
//     downloadJson (below) saves.
//   - anything else: no folder; openFolderStore() resolves to null and
//     everything stays in IndexedDB as before.
const STORAGE_API_URL = 'api/storage';
const NATIVE_STORAGE_FOLDER = 'CertificateQR/storage';

function storageFileName(key) {
  return key.replace(/^certqr:/, '');
}

// Both stores share one shape: get() resolves to the saved value,
// resolves to undefined if that file doesn't exist yet, and rejects if
// it exists but couldn't be read — hydrateKey treats those last two
// differently. set() rejects if the file couldn't be written; remove()
// deletes the file, and rejects if it couldn't (or wasn't there).
function makeDevServerFolderStore(folder) {
  return {
    location: folder,
    async get(key) {
      const res = await fetch(`${STORAGE_API_URL}/${storageFileName(key)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      return body.exists ? body.value : undefined;
    },
    async set(key, value) {
      const res = await fetch(`${STORAGE_API_URL}/${storageFileName(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    async remove(key) {
      const res = await fetch(`${STORAGE_API_URL}/${storageFileName(key)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
  };
}

function makeNativeFolderStore() {
  const { Filesystem } = window.Capacitor.Plugins;
  const pathFor = (key) => `${NATIVE_STORAGE_FOLDER}/${storageFileName(key)}.json`;
  return {
    location: `Documents/${NATIVE_STORAGE_FOLDER}`,
    async get(key) {
      let data;
      try {
        ({ data } = await Filesystem.readFile({ path: pathFor(key), directory: 'DOCUMENTS', encoding: 'utf8' }));
      } catch {
        return undefined;
      }
      return JSON.parse(data);
    },
    async set(key, value) {
      await Filesystem.writeFile({
        path: pathFor(key),
        data: JSON.stringify(value, null, 2),
        directory: 'DOCUMENTS',
        encoding: 'utf8',
        recursive: true,
      });
    },
    async remove(key) {
      await Filesystem.deleteFile({ path: pathFor(key), directory: 'DOCUMENTS' });
    },
  };
}

let folderStorePromise = null;

// Resolves to the folder store for however the app is running, or null
// if there isn't one. Never rejects, and only probes once per page.
function openFolderStore() {
  if (folderStorePromise) return folderStorePromise;
  folderStorePromise = (async () => {
    if (isNativeApp()) return makeNativeFolderStore();
    if (!/^https?:$/.test(window.location.protocol)) return null;
    try {
      // Any other server answers this with a 404 or an HTML page, which
      // fails one of the checks below — only vite.config.mjs's API
      // replies with JSON naming its folder.
      const res = await fetch(STORAGE_API_URL, { cache: 'no-store' });
      const info = res.ok ? await res.json() : null;
      return info && typeof info.folder === 'string' ? makeDevServerFolderStore(info.folder) : null;
    } catch {
      return null;
    }
  })();
  return folderStorePromise;
}

// Where this device's data is being saved, for the Settings page: the
// folder's path, or null when it's in the browser's own storage.
async function getStorageFolderLocation() {
  const folder = await openFolderStore();
  return folder ? folder.location : null;
}

// In-memory mirror of whatever's been hydrated from storage, so the
// rest of the app (and every page's existing synchronous
// loadHistory()/loadUutDatabase()-style calls) doesn't need to become
// async — only the one-time boot sequence on each page awaits
// hydrateStorage() before its first render.
const storageCache = new Map();

// Reads `key` from IndexedDB; if nothing's there yet, migrates whatever
// was left in localStorage under that same key from before this app
// used IndexedDB, then clears the old copy. Falls back to leaving the
// value in localStorage (and returning it from there) if IndexedDB
// itself is unavailable.
async function readBrowserStore(key) {
  let value;
  try {
    value = await idbGet(key);
  } catch {
    value = undefined;
  }
  if (value === undefined) {
    let legacy = null;
    try {
      const raw = localStorage.getItem(key);
      legacy = raw ? JSON.parse(raw) : null;
    } catch {
      legacy = null;
    }
    if (legacy != null) {
      value = legacy;
      try {
        await idbSet(key, value);
        localStorage.removeItem(key);
      } catch {
        // IndexedDB unavailable — leave the legacy copy in localStorage
        // in place; the caller still gets it for this session.
      }
    }
  }
  return value;
}

// Reads `key` into the cache — from its file in the storage folder when
// there is one. If that file doesn't exist yet, whatever this browser
// already held for the key (from before the folder was used) is copied
// into the folder so it carries over; the browser's copy is left where
// it is. A file that exists but can't be read is not overwritten.
async function hydrateKey(key) {
  const folder = await openFolderStore();
  let value;
  let missingFromFolder = false;
  if (folder) {
    try {
      value = await folder.get(key);
      missingFromFolder = value === undefined;
    } catch {
      value = undefined;
    }
  }
  if (value === undefined) {
    value = await readBrowserStore(key);
    if (missingFromFolder && value != null) {
      // Through writeStore rather than straight to the folder, so this
      // copy queues behind/under any real save instead of racing it.
      writeStore(key, value);
      return;
    }
  }
  storageCache.set(key, value);
}

// Called once per page, before its first render, with the list of keys
// that page actually needs (e.g. [HISTORY_KEY] on the Scans page,
// [HISTORY_KEY, TABS_STATE_KEY] on the Worksheet page).
async function hydrateStorage(keys) {
  await Promise.all(keys.map(hydrateKey));
}

function readStore(key, fallback) {
  const value = storageCache.get(key);
  return value == null ? fallback : value;
}

// Saves one value: to its file in the storage folder, or to IndexedDB
// if there's no folder or the write to it failed — so a save always
// lands somewhere a reload can find it. Never rejects.
async function persistValue(key, value) {
  const folder = await openFolderStore();
  if (folder) {
    try {
      await folder.set(key, value);
      return;
    } catch {
      // Folder unwritable right now (dev server stopped, storage
      // permission denied, disk full) — fall through to the browser.
    }
  }
  try {
    await idbSet(key, value);
  } catch {
    // IndexedDB unavailable (private browsing, quota denial, etc.) —
    // the in-memory cache still works for this session; fall back to
    // localStorage so at least a reload has something, quota allowing.
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Nothing further to do — the render still works for this session.
    }
  }
}

// One save in flight per key, and only ever of the newest value: the
// worksheet saves on every change, and whole-file writes that overlap
// could land out of order and leave an older state on disk. Anything
// written while a save is running just replaces what's waiting.
const pendingWrites = new Map();
const activeWriters = new Set();

async function drainWrites(key) {
  activeWriters.add(key);
  while (pendingWrites.has(key)) {
    const value = pendingWrites.get(key);
    pendingWrites.delete(key);
    await persistValue(key, value);
  }
  activeWriters.delete(key);
}

function writeStore(key, value) {
  storageCache.set(key, value);
  pendingWrites.set(key, value);
  if (!activeWriters.has(key)) drainWrites(key);
}

// Sets `key` to `value` and resolves once that has actually been
// written — for a restore (backup.js), which is followed by a page
// reload that a write still on its way wouldn't survive.
async function replaceStoredValue(key, value) {
  storageCache.set(key, value);
  pendingWrites.delete(key);
  await persistValue(key, value);
}

function loadHistory() {
  const parsed = readStore(HISTORY_KEY, []);
  return Array.isArray(parsed) ? parsed : [];
}

function saveHistoryEntries(entries) {
  writeStore(HISTORY_KEY, entries);
}

// Upserts by id+cert — re-scanning the same equipment/certificate
// replaces its existing entry and moves it to the front, rather than
// piling up duplicates every time the same code gets scanned again.
function addToHistory(payload) {
  const entries = loadHistory().filter((e) => !(e.id === payload.id && e.cert === payload.cert));
  entries.unshift({ ...payload, savedAt: new Date().toISOString() });
  saveHistoryEntries(entries);
  return entries;
}

function removeFromHistory(index) {
  const entries = loadHistory();
  entries.splice(index, 1);
  saveHistoryEntries(entries);
  return entries;
}

function clearHistory() {
  saveHistoryEntries([]);
}

// --- Calibration due ---
// Certificate data is good until its Ext. Cal. Due date; the due date
// itself still counts. After it:
//   - a scan of that certificate is turned away with a message instead
//     of saved (interpolate.js, lablog.js);
//   - one saved while it was still valid is kept, and marked as due
//     wherever it's listed. It can't be picked for a new worksheet or
//     taken out of the lab, but a worksheet already made with it goes
//     on showing the reference data it was made with — which is why
//     it isn't simply deleted.
// A blank or unreadable date is never treated as due — there's nothing
// to judge it by.
function isCalibrationDue(dueDateStr) {
  if (!dueDateStr) return false;
  const dueDate = new Date(dueDateStr);
  if (Number.isNaN(dueDate.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return dueDate < today;
}

// Whole days from today to the due date: 0 on the day itself, negative
// once it has passed. Null for a blank or unreadable date.
function daysUntilDue(dueDateStr) {
  if (!dueDateStr) return null;
  const dueDate = new Date(dueDateStr);
  if (Number.isNaN(dueDate.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((dueDate - today) / (1000 * 60 * 60 * 24));
}

// Still valid, but not for long: worth a warning wherever the equipment
// is about to be put to use, so recalibration can be booked before the
// date rather than discovered after it.
const DUE_SOON_DAYS = 30;

function isDueSoon(dueDateStr) {
  const days = daysUntilDue(dueDateStr);
  return days !== null && days >= 0 && days <= DUE_SOON_DAYS;
}

// "due today", "due in 1 day", "due in 12 days" — for a date that
// isDueSoon().
function dueSoonText(dueDateStr) {
  const days = daysUntilDue(dueDateStr);
  if (days === 0) return 'due today';
  return `due in ${days} day${days === 1 ? '' : 's'}`;
}

// --- A scan's certificates ---
// A label holds every current certificate of its equipment (scanner.js
// has the layout). Asked as one thing — "is this equipment's
// calibration valid?" — a scan answers with its `due`, the earliest of
// their dates, and that is what the Lab Log, the Home page and the
// Scans page go by. A worksheet asks more closely: each of its tables
// is read against one certificate, which is good or not by its own
// date.

// The certificates a saved scan holds, each with its own tables:
// [{ cert, trace, due, tables }]. A scan from before one code held them
// all is one certificate, with every table in it.
function scanCertificates(entry) {
  if (!entry) return [];
  const tables = Array.isArray(entry.tables) ? entry.tables : [];
  if (Array.isArray(entry.certs) && entry.certs.length > 0) {
    return entry.certs.map((c) => {
      const cert = (c && c.cert) || '';
      return { cert, trace: (c && c.trace) || '', due: (c && c.due) || '', tables: tables.filter((table) => table && table.cert === cert) };
    });
  }
  return [{ cert: entry.cert || '', trace: entry.trace || '', due: entry.due || '', tables }];
}

// Whether a scan has anything a worksheet can still be read against:
// at least one certificate within its due date.
function hasValidCertificate(entry) {
  return scanCertificates(entry).some((certificate) => !isCalibrationDue(certificate.due));
}

// Every certificate held for an equipment, across all the scans of it,
// from the most recent scan back. One that is on an earlier label too
// is taken from the newer scan only.
function heldCertificates(equipmentId) {
  const certificates = [];
  loadHistory().forEach((entry) => {
    if (!entry || entry.id !== equipmentId) return;
    scanCertificates(entry).forEach((certificate) => {
      if (!certificates.some((c) => c.cert === certificate.cert)) certificates.push(certificate);
    });
  });
  return certificates;
}

function dueCertificateMessage(payload) {
  const label = payload.name ? `${payload.id} — ${payload.name}` : payload.id;
  return `Calibration is due for ${label} (due date ${payload.due}). Nothing was saved — it needs recalibrating first.`;
}

// For a saved scan that has since gone past its date, when something
// tries to put it to new use.
function dueEquipmentMessage(entry, whatFor) {
  const label = entry.name ? `${entry.id} — ${entry.name}` : entry.id;
  return `Calibration is due for ${label} (due date ${entry.due}). It can't be ${whatFor} until it has been recalibrated and its new certificate scanned.`;
}
// --- Cross-page "use this scan in a worksheet" handoff ---
// Scanning itself lives entirely on interpolate.html now (a new tab's
// scanner adds straight to the active tab) — this key only carries the
// one-way case of opening a *past* scan on scans.html's Scans page and
// choosing "Use in a worksheet": scans.html sets {equipmentId,
// equipmentCert} before leaving, and interpolate.js reads it once on
// load, opens a new tab with that equipment pre-selected, and clears it.
const PENDING_WORKSHEET_EQUIP_KEY = 'certqr:pendingWorksheetEquip';

function getPendingWorksheetEquip() {
  try {
    const raw = localStorage.getItem(PENDING_WORKSHEET_EQUIP_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setPendingWorksheetEquip(state) {
  try {
    localStorage.setItem(PENDING_WORKSHEET_EQUIP_KEY, JSON.stringify(state));
  } catch {
    // Storage full/unavailable — the handoff just won't complete; the
    // scan itself (and its place in history) still works normally.
  }
}

function clearPendingWorksheetEquip() {
  try {
    localStorage.removeItem(PENDING_WORKSHEET_EQUIP_KEY);
  } catch {
    // no-op
  }
}

// --- "Edit this record" handoff ---
// The Records page's Edit button works like "Use in a worksheet" above:
// it leaves the record's id here and goes to the Worksheet page, which
// reads it once on load, opens that record as a worksheet (or goes to
// the worksheet it's already open in), and clears it.
const PENDING_WORKSHEET_RECORD_KEY = 'certqr:pendingWorksheetRecord';

function getPendingWorksheetRecord() {
  try {
    return localStorage.getItem(PENDING_WORKSHEET_RECORD_KEY);
  } catch {
    return null;
  }
}

function setPendingWorksheetRecord(recordId) {
  try {
    localStorage.setItem(PENDING_WORKSHEET_RECORD_KEY, recordId);
  } catch {
    // Storage unavailable — the handoff just won't complete.
  }
}

function clearPendingWorksheetRecord() {
  try {
    localStorage.removeItem(PENDING_WORKSHEET_RECORD_KEY);
  } catch {
    // no-op
  }
}

// --- Settings kept with the data ---
// Set on the Settings page, used by the pages that fill things in or
// send things out. Kept in the same store as everything else (not
// localStorage, like the theme) so they're in a backup and survive a
// move to another phone.
//   technician     — whoever uses this phone: the name a new worksheet
//                    starts with, and the one that goes on a shared log.
//   people         — names offered for "Taken by" on the Lab Log.
//   outTooLongDays — after this many days out of the lab, equipment is
//                    flagged.
const SETTINGS_KEY = 'certqr:settings';
const DEFAULT_OUT_TOO_LONG_DAYS = 7;

function loadSettings() {
  const saved = readStore(SETTINGS_KEY, null) || {};
  const days = Number(saved.outTooLongDays);
  return {
    technician: typeof saved.technician === 'string' ? saved.technician : '',
    people: Array.isArray(saved.people) ? saved.people.filter((name) => typeof name === 'string' && name.trim() !== '') : [],
    outTooLongDays: Number.isFinite(days) && days > 0 ? days : DEFAULT_OUT_TOO_LONG_DAYS,
    // What the Worksheet page makes: an unofficial record, with its own
    // simple table of readings, or one of the official worksheets
    // (worksheet-forms.js), picked per worksheet.
    recordMode: saved.recordMode === 'worksheet' ? 'worksheet' : 'unofficial',
  };
}

function saveSettings(settings) {
  writeStore(SETTINGS_KEY, settings);
}

// Adds a name to the people list if it isn't on it already (whatever
// the capitals). Returns whether it was added.
function rememberPerson(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return false;
  const settings = loadSettings();
  if (settings.people.some((person) => person.toLowerCase() === trimmed.toLowerCase())) return false;
  settings.people.push(trimmed);
  settings.people.sort((a, b) => a.localeCompare(b));
  saveSettings(settings);
  return true;
}

// --- Shared file-download + formatting helpers ---
// The download is app.js's (the Scans page's per-entry downloads); the
// formatting helpers are used by every page that lists saved things.

// True inside the Android app (Capacitor injects window.Capacitor into
// every page of its WebView); false in a regular browser, where that
// global doesn't exist at all.
function isNativeApp() {
  return Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

// The Android app's WebView has no download manager — clicking an
// <a download> blob: link there silently does nothing — so the app
// writes the file itself through Capacitor's Filesystem plugin, into
// Documents/CertificateQR where the phone's Files app can see it, then
// offers the share sheet for sending it on (email, Drive, etc.). If
// Documents can't be written (storage permission denied on Android 10
// and older), it falls back to a private cache copy and goes straight
// to the share sheet, since that copy isn't browsable on its own.
// Plugins are reached through the Capacitor.Plugins global rather than
// imported — same no-bundler pattern as the rest of this app.
const NATIVE_SAVE_FOLDER = 'CertificateQR';

async function saveJsonNative(filename, text) {
  const { Filesystem, Share } = window.Capacitor.Plugins;
  let uri;
  let savedTo = null;
  try {
    ({ uri } = await Filesystem.writeFile({
      path: `${NATIVE_SAVE_FOLDER}/${filename}`,
      data: text,
      directory: 'DOCUMENTS',
      encoding: 'utf8',
      recursive: true,
    }));
    savedTo = `Documents/${NATIVE_SAVE_FOLDER}/${filename}`;
  } catch {
    try {
      ({ uri } = await Filesystem.writeFile({ path: filename, data: text, directory: 'CACHE', encoding: 'utf8' }));
    } catch (err) {
      window.alert(`Could not save ${filename}: ${(err && err.message) || err}`);
      return;
    }
  }

  if (savedTo && !window.confirm(`Saved to ${savedTo}.\n\nShare it now?`)) return;
  try {
    await Share.share({ title: filename, files: [uri] });
  } catch {
    // Share sheet dismissed without picking anything — not an error.
  }
}

function downloadJson(filename, obj) {
  const text = JSON.stringify(obj, null, 2);
  if (isNativeApp()) {
    saveJsonNative(filename, text);
    return;
  }
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Not revoked — see equipment-tracker's exportEquipment.js downloadFile
  // for why (revoking races the browser's own download read for
  // anything beyond a trivial blob); this is a rare, manually-triggered
  // action, not something looping/repeated.
}

// --- Number-only boxes ---
// The boxes that take a number are plain text inputs (a type="number"
// one swallows a half-typed "-" or "0." and gives the page nothing to
// work with), so what keeps letters out of them is this: as the box is
// typed or pasted into, anything that isn't part of a number is dropped.

// One number: digits and a single decimal point, with a leading minus
// if `signed`. A comma is taken as the decimal point — it's what some
// phone keypads offer in place of one.
function cleanNumberText(text, signed) {
  let out = String(text).replace(/,/g, '.').replace(signed ? /[^0-9.-]/g : /[^0-9.]/g, '');
  // A minus only means something in front.
  if (signed) out = out.replace(/(?!^)-/g, '');
  const point = out.indexOf('.');
  if (point !== -1) out = out.slice(0, point + 1) + out.slice(point + 1).replace(/\./g, '');
  return out;
}

// Several numbers in one box — a worksheet's UUT Rdg takes a run of
// readings to average — kept apart by commas, spaces or "/". Each one
// is held to the same rules as a single signed number.
function cleanReadingsText(text) {
  return String(text)
    .replace(/[^0-9.,/\s-]/g, '')
    .replace(/[^,/\s]+/g, (reading) => cleanNumberText(reading, true));
}

// Holds `input` to what `clean` lets through. Call it before adding the
// box's own 'input' listeners, so they only ever see the cleaned text.
// The caret stays where it was among the characters that survived.
//
// A phone's ordinary keyboard types a word as a "composition" — the
// underlined word it's still guessing at — and puts its own idea of
// that word back over anything changed underneath it, so cleaning as
// each letter arrives doesn't stick there. The box is therefore cleaned
// again the moment the keyboard lets go of the word, and once more
// when the box is left; and since the rest of the page has by then
// heard about text that's no longer there, it's told again. (Boxes
// that ask for the number keypad — inputMode "decimal" — never get
// into this: that keypad has no letters and doesn't compose.)
function restrictInput(input, clean) {
  // True if something had to be taken out.
  function tidy() {
    const cleaned = clean(input.value);
    if (cleaned === input.value) return false;
    const caret = input.selectionStart == null ? cleaned.length : clean(input.value.slice(0, input.selectionStart)).length;
    input.value = cleaned;
    // A box that isn't the one being typed in has no caret to put back.
    if (document.activeElement === input) input.setSelectionRange(caret, caret);
    return true;
  }
  input.addEventListener('input', tidy);
  ['compositionend', 'blur'].forEach((type) => {
    input.addEventListener(type, () => {
      if (tidy()) input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
}

function safeFilenamePart(value) {
  return (value || 'untitled').replace(/[^A-Za-z0-9._-]/g, '_');
}

// Whether a table of readings was taken before the UUT was adjusted or
// after — the values a reading table's `stage` can hold
// (interpolate.js) and how each reads wherever a saved record shows it
// (database.js). A table with no stage is one where the question
// didn't come up.
const ADJUST_STAGES = {
  before: 'Before adjust',
  after: 'After adjust',
};

// --- Reading tables ---
// A worksheet, and a record saved from one, holds its readings as
// `tables`: one entry per table on the page, each with its own stage
// and rows. It wasn't always so — a worksheet used to be a single table,
// with `rows` (and what they were read against) directly on it, and for
// a while each of those rows carried a `stage` of its own.
// worksheetTables() reads either shape as tables: the old one becomes a
// table per stage its rows were marked with, in the order first seen.
function isBlankRow(row) {
  return !row || (!String(row.labRdg || '').trim() && !String(row.uutRdg || '').trim() && rowPhotoIds([row]).length === 0);
}

function splitRowsByStage(rows) {
  const all = Array.isArray(rows) ? rows : [];
  // Placeholder rows aren't a table of their own next to real ones.
  const filled = all.filter((row) => !isBlankRow(row));
  if (filled.length === 0) return all.length > 0 ? [{ stage: '', rows: all }] : [];
  const groups = new Map();
  filled.forEach((row) => {
    const stage = ADJUST_STAGES[row.stage] ? row.stage : '';
    if (!groups.has(stage)) groups.set(stage, { stage, rows: [] });
    groups.get(stage).rows.push(row);
  });
  return Array.from(groups.values());
}

// Accuracy (the tol* fields) went the same way later: set once on the
// worksheet at first, then per table. A table that has none of its own
// is given the worksheet's.
function worksheetTables(holder) {
  if (!holder) return [];
  const accuracy = { tolType: holder.tolType, tolPct: holder.tolPct, tolFs: holder.tolFs, tolAdd: holder.tolAdd };
  if (Array.isArray(holder.tables)) {
    return holder.tables.map((table) => (table && table.tolType === undefined && holder.tolType !== undefined ? { ...accuracy, ...table } : table));
  }
  const shared = {
    ...accuracy,
    tableIndex: holder.tableIndex,
    uutUnit: holder.uutUnit,
    scopeUnitLabel: holder.scopeUnitLabel,
    labRdgHeader: holder.labRdgHeader,
    uutRdgHeader: holder.uutRdgHeader,
  };
  return splitRowsByStage(holder.rows).map(({ stage, rows }) => ({ ...shared, stage, rows }));
}

// A table's accuracy in words — "± 0.2 mbar", "± (0.5 % rdg + 0.2 mbar)",
// "± (0.1 % FS of 1000 + 0.2)" — for wherever a saved record shows it.
// '' when none was entered. The fixed part is in the unit the table's
// readings are in, when that's known.
function formatAccuracy(table) {
  if (!table) return '';
  const clean = (value) => String(value == null ? '' : value).trim();
  const fixed = clean(table.tolAdd) && `${clean(table.tolAdd)}${table.uutUnit ? ` ${table.uutUnit}` : ''}`;
  const parts = [];
  if (table.tolType === 'pct_rdg_add' && clean(table.tolPct)) parts.push(`${clean(table.tolPct)} % rdg`);
  if (table.tolType === 'pct_fs_add' && clean(table.tolPct)) parts.push(`${clean(table.tolPct)} % FS${clean(table.tolFs) ? ` of ${clean(table.tolFs)}` : ''}`);
  if (fixed) parts.push(fixed);
  if (parts.length === 0) return '';
  return parts.length === 1 ? `± ${parts[0]}` : `± (${parts.join(' + ')})`;
}

// The certificate one table of a saved record was read against, as a
// line for under that table's heading — but only in a record whose
// tables were not all read against the same one, where Reference Info
// can't say which was whose. '' otherwise, which covers every record
// from before a table kept its own.
function tableCertificateLine(table, tables) {
  const named = (t) => (t && t.cert ? t.cert : null);
  const distinct = new Set((Array.isArray(tables) ? tables : []).map(named).filter(Boolean));
  if (distinct.size < 2 || !named(table)) return '';
  return `Certificate: ${table.cert}${table.certDue ? ` (due ${table.certDue})` : ''}`;
}

function formatSavedAt(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

// --- Days and times of day ---
// The Lab Log and the Shared Log both list things under the day they
// happened on. Everything is stored as an ISO time stamp and only
// turned into a local day/time here, so the grouping follows the clock
// of whichever device is showing it.
function dayKey(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDay(iso) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// "[Model] SN: [Serial]" — the display name (and filename basis) for a
// saved UUT record. Degrades gracefully if only one of the two is set;
// null if neither is (callers should guard against saving that case).
function formatUutLabel(model, serial) {
  const parts = [];
  if (model && model.trim()) parts.push(model.trim());
  if (serial && serial.trim()) parts.push(`SN: ${serial.trim()}`);
  return parts.length > 0 ? parts.join(' ') : null;
}

// --- Saved UUT records ("database") ---
// Written by interpolate.html's Save button, browsed on database.html.
// Each record is a frozen snapshot of one worksheet tab at the moment
// Save was clicked — model/serial/unit, the calibration info it was
// checked against, and the interpolation rows as computed at that time
// (not just raw inputs), so it stays meaningful even if that equipment's
// certificate or history entry changes later.
const UUT_DATABASE_KEY = 'certqr:uutDatabase';

function loadUutDatabase() {
  const parsed = readStore(UUT_DATABASE_KEY, []);
  return Array.isArray(parsed) ? parsed : [];
}

function saveUutDatabaseEntries(entries) {
  writeStore(UUT_DATABASE_KEY, entries);
}

function addUutRecord(record) {
  const entries = loadUutDatabase();
  entries.unshift(record);
  saveUutDatabaseEntries(entries);
  return entries;
}

function removeUutRecord(index) {
  const entries = loadUutDatabase();
  entries.splice(index, 1);
  saveUutDatabaseEntries(entries);
  return entries;
}

function clearUutDatabase() {
  saveUutDatabaseEntries([]);
}
// A record's id is what lets the worksheet it was saved from find it
// again — to save over it rather than beside it — and what lets the
// Records page hand one back to the Worksheet page to be edited.
function makeRecordId() {
  return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Records saved before they had ids are given one the first time a page
// that goes by them loads.
function ensureRecordIds() {
  const entries = loadUutDatabase();
  let changed = false;
  entries.forEach((record) => {
    if (record && !record.id) {
      record.id = makeRecordId();
      changed = true;
    }
  });
  if (changed) saveUutDatabaseEntries(entries);
}

// Saves `record` in place of the one with that id, where it stood in
// the list. False if there's no such record any more.
function replaceUutRecord(id, record) {
  const entries = loadUutDatabase();
  const index = entries.findIndex((entry) => entry && entry.id === id);
  if (index === -1) return false;
  entries[index] = record;
  saveUutDatabaseEntries(entries);
  return true;
}

// How a record came out overall: 'fail' if any reading was out of
// tolerance, 'pass' if readings were judged and none was, '' if there
// was no tolerance to judge by. A record from before the result was
// kept can still be told to have failed, from its rows.
const RESULT_LABELS = { pass: 'Pass', fail: 'Fail' };

function recordResult(record) {
  if (!record) return '';
  if (record.result === 'pass' || record.result === 'fail') return record.result;
  const failed = worksheetTables(record).some((table) => (Array.isArray(table.rows) ? table.rows : []).some((row) => row && row.outOfTolerance));
  return failed ? 'fail' : '';
}


// --- Equipment in/out log ("Lab Log") ---
// Written and browsed on lablog.html (lablog.js). One entry per trip
// out of the lab: { id, equipmentId, equipmentName, takenBy, note,
// outAt, inAt } — outAt is stamped when the equipment is taken, inAt
// when it comes back (null while it's still out). Newest trip first.
const LAB_LOG_KEY = 'certqr:labLog';

function loadLabLog() {
  const parsed = readStore(LAB_LOG_KEY, []);
  return Array.isArray(parsed) ? parsed : [];
}

function saveLabLogEntries(entries) {
  writeStore(LAB_LOG_KEY, entries);
}

// How many whole days a piece of equipment has been out of the lab (or
// was, for a trip that's over).
function daysOutOfLab(entry) {
  const until = entry.inAt ? new Date(entry.inAt) : new Date();
  return Math.max(0, Math.floor((until - new Date(entry.outAt)) / (1000 * 60 * 60 * 24)));
}

// When the last backup was made (backup.js makes them, and notes it
// here; the Home page reads it to say when one is overdue). Kept in
// localStorage, not with the data: it's a fact about this phone, and
// restoring a backup shouldn't bring an old answer back with it.
const LAST_BACKUP_KEY = 'certqr:lastBackup';

function lastBackupAt() {
  try {
    return localStorage.getItem(LAST_BACKUP_KEY);
  } catch {
    return null;
  }
}

// --- Sharing ---
// Two ways out of the app, both through the phone's share sheet: a piece
// of text (the in/out log, lablog.js) and a single file (a PDF of saved
// worksheets, database.js). Each resolves to { outcome, via }:
//   outcome 'shared'     — handed to another app. `via` names it when
//                          the phone says which (the Android app does).
//           'copied'     — text only: nothing to share with here, so it
//                          went to the clipboard instead.
//           'downloaded' — file only: no sharing a file here (a desktop
//                          browser without it), so it was saved as a
//                          download instead.
//           'cancelled'  — the share sheet was closed without choosing.
//           'failed'     — none of the above was possible.
// Whoever calls these records what went out in the shared log (below) —
// for every outcome but the last two.

// The apps a share most often goes to, by the name Android knows them
// under; any other is shown by that name as it is.
const SHARE_TARGET_NAMES = {
  'com.whatsapp': 'WhatsApp',
  'com.whatsapp.w4b': 'WhatsApp Business',
  'org.telegram.messenger': 'Telegram',
  'com.google.android.gm': 'Gmail',
  'com.microsoft.office.outlook': 'Outlook',
  'com.samsung.android.email.provider': 'Samsung Email',
  'com.google.android.apps.docs': 'Google Drive',
  'com.microsoft.skydrive': 'OneDrive',
  'com.microsoft.teams': 'Teams',
  'com.google.android.apps.messaging': 'Messages',
  'com.samsung.android.messaging': 'Messages',
  'com.google.android.bluetooth': 'Bluetooth',
  'com.android.bluetooth': 'Bluetooth',
  'com.google.android.gms': 'Quick Share',
  'com.samsung.android.app.sharelive': 'Quick Share',
};

function shareTargetName(packageName) {
  return packageName ? SHARE_TARGET_NAMES[packageName] || packageName : '';
}

// The Android share sheet, with whatever `options` Capacitor's Share
// plugin takes. It rejects when the sheet is closed without a choice.
async function shareNatively(options) {
  try {
    const result = await window.Capacitor.Plugins.Share.share(options);
    return { outcome: 'shared', via: shareTargetName(result && result.activityType) };
  } catch {
    return { outcome: 'cancelled', via: '' };
  }
}

async function shareText(title, text) {
  if (isNativeApp()) return shareNatively({ title, text, dialogTitle: title });
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return { outcome: 'shared', via: '' };
    } catch (err) {
      if (err && err.name === 'AbortError') return { outcome: 'cancelled', via: '' };
      // Anything else (sharing text unsupported here) — fall through.
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return { outcome: 'copied', via: '' };
  } catch {
    return { outcome: 'failed', via: '' };
  }
}

// One file, with a line or two of `text` to say what it is. One,
// deliberately: a share of several files at once is where receiving apps
// differ, and some keep only the text. `bytes` is the file's content
// (a Uint8Array).
function bytesToBase64(bytes) {
  let binary = '';
  // In slices: one String.fromCharCode call can't take a whole file's
  // worth of arguments.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function shareFile(title, text, fileName, mimeType, bytes) {
  if (isNativeApp()) {
    let uri;
    try {
      // A copy in the app's cache — somewhere the share sheet can always
      // reach. A folder per share keeps one file from replacing another
      // of the same name that an app is still reading.
      ({ uri } = await window.Capacitor.Plugins.Filesystem.writeFile({
        path: `share-${Date.now().toString(36)}/${fileName}`,
        data: bytesToBase64(bytes),
        directory: 'CACHE',
        recursive: true,
      }));
    } catch {
      return { outcome: 'failed', via: '' };
    }
    return shareNatively({ title, text, files: [uri], dialogTitle: title });
  }

  const file = new File([bytes], fileName, { type: mimeType });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ title, text, files: [file] });
      return { outcome: 'shared', via: '' };
    } catch (err) {
      if (err && err.name === 'AbortError') return { outcome: 'cancelled', via: '' };
      // Refused for some other reason — fall through to a download.
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Not revoked — see downloadJson.
  return { outcome: 'downloaded', via: '' };
}

// --- Shared log ---
// What has gone out of the app through the two functions above, newest
// first — browsed on sharelog.html (sharelog.js). Written by the pages
// that share (database.js, lablog.js), which have to have hydrated
// SHARE_LOG_KEY first: adding to a log that hasn't been read yet would
// save over what's already in it. One entry:
//   { id, at, kind, title, outcome, via, … }
// kind 'worksheets' — a PDF of saved worksheets: customer, fileName,
//                     pages, photos, and items: [{ label, savedAt }].
// kind 'lablog'     — the in/out log as text: `text` is what was sent.
const SHARE_LOG_KEY = 'certqr:shareLog';

function loadShareLog() {
  const parsed = readStore(SHARE_LOG_KEY, []);
  return Array.isArray(parsed) ? parsed : [];
}

function saveShareLogEntries(entries) {
  writeStore(SHARE_LOG_KEY, entries);
}

// Records one share. `result` is what shareText/shareFile resolved to;
// a share that was cancelled or failed isn't one, and isn't recorded.
function addShareLogEntry(result, entry) {
  if (!result || result.outcome === 'cancelled' || result.outcome === 'failed') return;
  const entries = loadShareLog();
  entries.unshift({
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    outcome: result.outcome,
    via: result.via || '',
    ...entry,
  });
  saveShareLogEntries(entries);
}

// --- Customer folders ---
// Worksheets are filed under a customer: interpolate.js keeps each open
// worksheet's customerId alongside the rest of its state, a saved
// record carries the customerId (and the name as it was then) it was
// saved under, and database.js lists records one folder at a time.
// A worksheet or record with no customerId is unfiled. [{ id, name }].
const CUSTOMERS_KEY = 'certqr:customers';
const UNFILED_LABEL = 'No customer (unfiled)';

function loadCustomers() {
  const parsed = readStore(CUSTOMERS_KEY, []);
  return Array.isArray(parsed) ? parsed : [];
}

function saveCustomers(customers) {
  writeStore(CUSTOMERS_KEY, customers);
}

// --- Open worksheets ---
// Owned by interpolate.js (see its "Tab (worksheet) management"); the
// key lives here because database.js reads it too, to know which
// reading photos are still in use.
const TABS_STATE_KEY = 'certqr:interpTabs';

// --- Reading photos, in use ---
// A photo taken against a worksheet row is stored once (photos.js) and
// referred to by id from that row — and from every record the worksheet
// is saved as, since a record is a copy of the rows as they were. So a
// photo can only be deleted once neither an open worksheet nor a saved
// record still refers to it.
function rowPhotoIds(rows) {
  const ids = [];
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    if (row && Array.isArray(row.photos)) ids.push(...row.photos);
  });
  return ids;
}

// Every photo a worksheet or a record refers to, across all its tables.
function worksheetPhotoIds(holder) {
  const ids = [];
  worksheetTables(holder).forEach((table) => ids.push(...rowPhotoIds(table && table.rows)));
  return ids;
}

function photoIdsInUse() {
  const ids = new Set();
  loadUutDatabase().forEach((record) => worksheetPhotoIds(record).forEach((id) => ids.add(id)));
  const tabsState = readStore(TABS_STATE_KEY, null);
  const tabs = tabsState && Array.isArray(tabsState.tabs) ? tabsState.tabs : [];
  tabs.forEach((tab) => worksheetPhotoIds(tab).forEach((id) => ids.add(id)));
  return ids;
}
