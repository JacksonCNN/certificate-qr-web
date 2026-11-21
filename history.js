// history.js — scan history and the storage layer under it, shared by
// scans.html (app.js lists it) and interpolate.html (interpolate.js
// writes to it after every successful decode and reads it as the
// reference-data picker). Plain globals, no bundler/module system —
// same pattern as jsQR/pako being loaded as plain <script> globals in
// this offline app. Nothing here leaves this device unless it's been
// connected to a shared server (see "Shared server" below).

// --- Older Android WebViews ---
// A tablet whose Android System WebView is never updated (no Google
// account on it, or a carrier build) can be years behind. Before
// Chrome 103 there's no AbortSignal.timeout, and every fetch given one
// — the update check, the shared server, photos, QR dictionaries —
// failed before it started, without a word. This gives it one, the
// same: aborted after `ms`. Loaded first on every page, so everything
// after can use it.
if (typeof AbortSignal !== 'undefined' && typeof AbortController !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = function timeout(ms) {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
    return controller.signal;
  };
}

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

// --- Shared server ---
// Set up on the Settings page (server address + this person's access
// code), the collections below are kept on the team's shared server
// (server/server.mjs) instead of on this device alone, so everyone sees
// the same scans, records, lab log, customer folders and shared log.
// The person's own things — open worksheets, settings, the converter —
// go there too, but kept apart per person: they follow the person to
// another phone, and no one else sees them. Photos don't come through
// here: photos.js sends and fetches them itself.
//
// It has to keep working with no connection, and with many people
// saving at once, so for each collection this device keeps a record
// (IndexedDB, under SERVER_RECORD_PREFIX + key):
//   value   — what this device holds now, its own changes included
//   base    — what `value` was last built on: the last value this
//             device sent, or got from the server. undefined when there
//             is none (this device's data from before it was
//             connected, or a restored backup) — then nothing in
//             `value` counts as deleted, it's all added.
//   remote  — the server's copy as last seen, and `version` its version
//   dirty   — `value` has changes the server doesn't have yet
// A change is saved into that record first, so it's never lost, then
// sent. The server only takes a save made on its current version; if
// someone else saved in between, it sends back what it has now, and
// this device merges (mergeStoredValues) and sends again. Offline, the
// change stays dirty and goes when the server can be reached: on the
// next page load, when the phone comes back online, or on a timer.
//
// Within one page, what the page holds is never swapped for the merged
// result under it: pages read, change and save whole lists, and one
// still holding its own list would otherwise save over what came in.
// Other people's changes appear on the next page load.
const SERVER_CONFIG_KEY = 'certqr:server';
const SERVER_RECORD_PREFIX = 'certqr-server:';
// Must be among SHARED/PERSONAL in server/server.mjs.
//
// Open worksheets (certqr:interpTabs) are not among them: they're work
// in progress, kept on this phone only. A worksheet reaches the server
// when it's saved, as a record (certqr:uutDatabase).
const SERVER_COLLECTIONS = {
  'certqr:history': 'history',
  'certqr:uutDatabase': 'uutDatabase',
  'certqr:labLog': 'labLog',
  'certqr:customers': 'customers',
  'certqr:shareLog': 'shareLog',
  'certqr:worksheetTemplates': 'worksheetTemplates',
  'certqr:settings': 'settings',
  'certqr:converter': 'converter',
};
// Everyone reads these; only an admin can save them (server.mjs's
// ADMIN_ONLY). Not in backups either: they live on the server.
const ADMIN_ONLY_SERVER_KEYS = new Set(['certqr:worksheetTemplates']);
// Kept with the server once, and on this phone only now. Whatever the
// phone last held of them there becomes its own copy the first time
// they're read (takeBackFromServer).
const FORMER_SERVER_KEYS = ['certqr:interpTabs'];
const SERVER_READ_TIMEOUT_MS = 5000;
const SERVER_WRITE_TIMEOUT_MS = 20000;
const SERVER_RETRY_MS = 30000;

function serverCollectionName(key) {
  return Object.prototype.hasOwnProperty.call(SERVER_COLLECTIONS, key) ? SERVER_COLLECTIONS[key] : null;
}

// { url, token, userId, userName, admin, signedOut }, or null when not
// connected. `token` is what the server gave this device when it signed
// in (never the password). `signedOut` is set when the server stops
// accepting it (password changed, person turned off): from then on the
// device doesn't ask the server anything until it's signed in again,
// and keeps its unsent changes meanwhile. Kept in localStorage: it's
// about this device, and has to be there before any data is read.
function loadServerConfig() {
  try {
    const config = JSON.parse(localStorage.getItem(SERVER_CONFIG_KEY) || 'null');
    return config && typeof config.url === 'string' && typeof config.token === 'string' ? config : null;
  } catch {
    return null;
  }
}

function serverConfigFor(key) {
  return serverCollectionName(key) ? loadServerConfig() : null;
}

function saveServerConfig(config) {
  localStorage.setItem(SERVER_CONFIG_KEY, JSON.stringify(config));
  // The account list shows the name and admin as they are now.
  updateSavedAccount(config);
}

// Whether to try the server at all just now.
function serverReachable(config) {
  return navigator.onLine !== false && !config.signedOut;
}

// "certqr.example.com" → "https://certqr.example.com". Plain http only
// for a server on this device or the local network, for trying it out.
function normalizeServerUrl(input) {
  let text = String(input || '').trim();
  if (!text) throw new Error('Enter the server address.');
  if (!/^[a-z]+:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('That isn\'t a web address.');
  }
  const local = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('The address has to start with https://');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

async function serverRequest(config, method, path, body, timeoutMs) {
  const headers = { Authorization: `Bearer ${config.token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${config.url}/api/v1/${path}`, {
    method,
    headers,
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

function serverFailure(status, data) {
  const err = new Error((data && data.error) || `Server answered ${status}`);
  err.status = status;
  return err;
}

// Signs in with a login ID and password; resolves to { token, id, name,
// admin }, or rejects with a message fit to show.
function signInToServer(url, loginId, password) {
  return postSignIn(url, 'login', { id: loginId, password });
}

// Either way of signing in: with a password ('login'), or with an
// invite and the password being chosen ('invite/accept').
async function postSignIn(url, path, body) {
  let response;
  try {
    const res = await fetch(`${url}/api/v1/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SERVER_WRITE_TIMEOUT_MS),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    response = { status: res.status, data };
  } catch {
    // Marked, so signing in can fall back to the password kept on this
    // phone (signInToAccount).
    const err = new Error('Couldn\'t reach the server. Check the address and the connection.');
    err.unreachable = true;
    throw err;
  }
  const { status, data } = response;
  if (status === 200 && data && typeof data.token === 'string' && typeof data.id === 'string') {
    return { token: data.token, id: data.id, name: String(data.name || data.id), admin: Boolean(data.admin) };
  }
  throw new Error((data && data.error) || `The server answered unexpectedly (${status}).`);
}

// --- Its state, for the Settings page ---
// state: 'off' | 'online' | 'offline' | 'signed-out' | 'error'.
// Pages hear of changes through a 'certqr:server-status' event.
const serverStatus = (() => {
  const config = loadServerConfig();
  return { state: !config ? 'off' : config.signedOut ? 'signed-out' : 'online', message: '', lastSyncAt: null };
})();
const serverDirtyKeys = new Set();

function getServerStatus() {
  return { ...serverStatus, pending: serverDirtyKeys.size };
}

function setServerStatus(patch) {
  Object.assign(serverStatus, patch);
  try {
    window.dispatchEvent(new CustomEvent('certqr:server-status'));
  } catch {
    // no-op
  }
}

function noteServerSynced(key) {
  serverDirtyKeys.delete(key);
  setServerStatus({ state: 'online', message: '', lastSyncAt: new Date().toISOString() });
}

let serverRetryTimer = null;

function noteServerFailure(key, err) {
  if (key) serverDirtyKeys.add(key);
  if (err && err.status === 401) {
    // Not asked again until signed in again (serverReachable).
    const config = loadServerConfig();
    if (config && !config.signedOut) saveServerConfig({ ...config, signedOut: true });
    setServerStatus({ state: 'signed-out', message: '' });
    return;
  }
  const config = loadServerConfig();
  if (config && config.signedOut) {
    setServerStatus({ state: 'signed-out', message: '' });
    return;
  }
  if (err && err.status && err.status !== 503 && err.status !== 429) {
    setServerStatus({ state: 'error', message: err.message });
  } else {
    setServerStatus({ state: 'offline', message: err && err.status === 503 ? err.message : '' });
  }
  if (!serverRetryTimer) {
    serverRetryTimer = setTimeout(() => {
      serverRetryTimer = null;
      flushServerQueue();
    }, SERVER_RETRY_MS);
  }
}

// --- Merging ---
// Three-way: what this device's change was built on (base), the change
// (mine) and the server's copy now (theirs). In a list, each item is
// matched by its id (a scan by equipment id + certificate, as
// addToHistory keeps one per pair):
//   - added on either side: kept (both added the same one: mine);
//   - changed on one side only: that side's;
//   - changed on both: mine;
//   - deleted on one side: deleted — unless the other side changed it
//     meanwhile, then that change is kept, since losing work is worse
//     than having to delete something twice.
// Order follows mine, with the server's own additions placed where they
// stand in its list (in front, for these newest-first lists).
// Anything that isn't a list — settings, open worksheets — is merged
// one top-level field at a time by the same rule. With no base at all,
// nothing is a deletion: mine and theirs are put together.
function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeItemKey(storageKey) {
  if (storageKey === 'certqr:history') return (item) => (item && item.id != null ? `${item.id}\u0000${item.cert || ''}` : null);
  return (item) => (item && item.id != null ? String(item.id) : null);
}

function mergeLists(base, mine, theirs, keyOf) {
  const keyFor = (item) => {
    const key = keyOf(item);
    return key == null ? `json:${JSON.stringify(item)}` : `id:${key}`;
  };
  const toMap = (list) => {
    const map = new Map();
    list.forEach((item) => {
      const key = keyFor(item);
      if (!map.has(key)) map.set(key, item);
    });
    return map;
  };
  const hasBase = Array.isArray(base);
  const baseMap = toMap(hasBase ? base : []);
  const mineMap = toMap(mine);
  const theirsMap = toMap(theirs);
  const DROP = {};

  function decide(key) {
    const inBase = baseMap.has(key);
    const inMine = mineMap.has(key);
    const inTheirs = theirsMap.has(key);
    if (!inBase) return inMine ? mineMap.get(key) : theirsMap.get(key);
    const was = baseMap.get(key);
    if (!inMine && !inTheirs) return DROP;
    if (!inMine) return sameJson(theirsMap.get(key), was) ? DROP : theirsMap.get(key);
    if (!inTheirs) return sameJson(mineMap.get(key), was) ? DROP : mineMap.get(key);
    return sameJson(mineMap.get(key), was) ? theirsMap.get(key) : mineMap.get(key);
  }

  // Placed by [position in mine, 0 = before it / 1 = it, order in theirs].
  const placed = [];
  const minePosition = new Map();
  const seen = new Set();
  mine.forEach((item, index) => {
    const key = keyFor(item);
    if (seen.has(key)) return;
    seen.add(key);
    minePosition.set(key, index);
    const value = decide(key);
    if (value !== DROP) placed.push({ sort: [index, 1, 0], value });
  });
  let nextMinePosition = Infinity;
  for (let index = theirs.length - 1; index >= 0; index -= 1) {
    const key = keyFor(theirs[index]);
    if (minePosition.has(key)) {
      nextMinePosition = minePosition.get(key);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const value = decide(key);
    if (value !== DROP) placed.push({ sort: [nextMinePosition, 0, index], value });
  }
  placed.sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.sort[2] - b.sort[2]);
  return placed.map((entry) => entry.value);
}

function mergeObjects(base, mine, theirs) {
  const was = isPlainObject(base) ? base : {};
  const hasBase = isPlainObject(base);
  const out = {};
  new Set([...Object.keys(mine), ...Object.keys(theirs)]).forEach((field) => {
    // With no base, a field this side doesn't have was never removed.
    const changedHere = hasBase ? !sameJson(mine[field], was[field]) : field in mine;
    const value = changedHere ? mine[field] : theirs[field];
    if (value !== undefined) out[field] = value;
  });
  return out;
}

function mergeStoredValues(storageKey, base, mine, theirs) {
  if (mine == null) return theirs == null ? mine : theirs;
  if (theirs == null) return mine;
  if (Array.isArray(mine) && Array.isArray(theirs)) return mergeLists(base, mine, theirs, mergeItemKey(storageKey));
  if (isPlainObject(mine) && isPlainObject(theirs)) return mergeObjects(base, mine, theirs);
  return mine;
}

// --- This device's records ---
// Kept in memory as well, for when IndexedDB isn't available (private
// browsing): then they last as long as the page.
const serverRecordsInMemory = new Map();

function serverRecordScope(config) {
  return `${config.url}|${config.userId || ''}`;
}

function newServerRecord(config) {
  return { scope: serverRecordScope(config), value: undefined, base: undefined, remote: undefined, version: null, dirty: false };
}

async function readServerRecord(key, config) {
  let record = serverRecordsInMemory.get(key);
  try {
    record = (await idbGet(SERVER_RECORD_PREFIX + key)) || record;
  } catch {
    // IndexedDB unavailable — the in-memory copy, if any.
  }
  // One from another server or another person's code is not this one's.
  if (!record || record.scope !== serverRecordScope(config)) return null;
  if (record.dirty) serverDirtyKeys.add(key);
  return record;
}

async function writeServerRecord(key, record) {
  serverRecordsInMemory.set(key, record);
  try {
    await idbSet(SERVER_RECORD_PREFIX + key, record);
  } catch {
    // Kept in memory only, for this page.
  }
}

// One thing at a time per collection: a load, a save or a retry.
const serverKeyLocks = new Map();

function withServerKeyLock(key, work) {
  const previous = serverKeyLocks.get(key) || Promise.resolve();
  const run = previous.then(() => work());
  const tail = run.catch(() => {});
  serverKeyLocks.set(key, tail);
  return run;
}

// What this device held for `key` before it was connected: its storage
// folder's file, or the browser's copy.
async function readLocalValue(key) {
  const folder = await openFolderStore();
  if (folder) {
    try {
      const value = await folder.get(key);
      if (value !== undefined) return value;
    } catch {
      // Unreadable — try the browser's copy.
    }
  }
  return readBrowserStore(key);
}

// Sends a dirty record's change, merging as often as someone else got
// there first. Resolves to { merged, version }; rejects when the server
// can't be reached or refuses.
async function pushServerRecord(key, config, record) {
  const name = serverCollectionName(key);
  let remoteValue = record.remote;
  let remoteVersion = record.version || null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const merged = mergeStoredValues(key, record.base, record.value, remoteValue);
    if (merged == null) return { merged, version: remoteVersion };
    const { status, data } = await serverRequest(config, 'PUT', `data/${name}`, { value: merged, baseVersion: remoteVersion }, SERVER_WRITE_TIMEOUT_MS);
    if (status === 200 && data && typeof data.version === 'string') return { merged, version: data.version };
    if (status === 409 && data) {
      remoteValue = data.exists ? data.value : undefined;
      remoteVersion = data.exists ? data.version : null;
      continue;
    }
    throw serverFailure(status, data);
  }
  throw new Error('Others kept saving at the same moment; will try again.');
}

// Tries to send a dirty record; true if it went. Either way the record
// is saved as it now stands.
async function syncServerRecord(key, config, record) {
  if (!serverReachable(config)) {
    // Offline or signed out: kept, and sent once that's over.
    await writeServerRecord(key, record);
    noteServerFailure(key, null);
    return false;
  }
  try {
    // What the server already had of it, for the sync log: the last
    // copy agreed with it, or (first time, or a restore) its own copy.
    const before = record.base !== undefined ? record.base : record.remote;
    const { merged, version } = await pushServerRecord(key, config, record);
    noteSyncSent(key, describeServerChange(key, before, record.value));
    record.base = record.value;
    record.remote = merged;
    record.version = version;
    record.dirty = false;
    await writeServerRecord(key, record);
    noteServerSynced(key);
    return true;
  } catch (err) {
    // A collection only an admin can change (the worksheet templates),
    // changed here by someone who isn't one (any more): the change can
    // never go, so it's let go of and the server's copy is used.
    if (err.status === 403 && ADMIN_ONLY_SERVER_KEYS.has(key)) {
      record.value = record.remote;
      record.base = record.remote;
      record.dirty = false;
      await writeServerRecord(key, record);
      noteServerSynced(key);
      storageCache.set(key, record.value);
      return false;
    }
    await writeServerRecord(key, record);
    noteServerFailure(key, err);
    return false;
  }
}

async function hydrateServerKey(key, config) {
  await withServerKeyLock(key, async () => {
    let record = await readServerRecord(key, config);
    let remote = null;
    if (serverReachable(config)) {
      try {
        const { status, data } = await serverRequest(config, 'GET', `data/${serverCollectionName(key)}`, undefined, SERVER_READ_TIMEOUT_MS);
        if (status !== 200 || !data) throw serverFailure(status, data);
        remote = { value: data.exists ? data.value : undefined, version: data.exists ? data.version : null };
      } catch (err) {
        noteServerFailure(null, err);
      }
    } else {
      noteServerFailure(null, null);
    }

    if (!record) {
      // First time on this server: what this device already held joins
      // what's there (nothing in it counts as deleted).
      const local = await readLocalValue(key);
      record = newServerRecord(config);
      record.value = local;
      record.dirty = local != null && !(remote && sameJson(local, remote.value));
      if (record.dirty) {
        serverDirtyKeys.add(key);
        await writeServerRecord(key, record);
      }
    }

    if (!remote) {
      // Offline: work from this device's copy.
      storageCache.set(key, record.value);
      return;
    }

    record.remote = remote.value;
    record.version = remote.version;
    if (record.dirty && !(await syncServerRecord(key, config, record))) {
      storageCache.set(key, record.value);
      return;
    }
    const latest = record.remote;
    record.value = latest;
    record.base = latest;
    record.dirty = false;
    await writeServerRecord(key, record);
    noteServerSynced(key);
    storageCache.set(key, latest);
  });
}

async function persistServerValue(key, value, config) {
  await withServerKeyLock(key, async () => {
    const record = (await readServerRecord(key, config)) || newServerRecord(config);
    record.value = value;
    record.dirty = true;
    serverDirtyKeys.add(key);
    await writeServerRecord(key, record);
    await syncServerRecord(key, config, record);
  });
}

// A restore while connected: what the backup holds is put together with
// what's on the server, not swapped in for it — swapping would delete
// everyone else's work. Resolves to what the collection now holds.
async function restoreServerValue(key, value, config) {
  if (isPartialKey(key)) return restorePartialValue(key, value, config);
  return withServerKeyLock(key, async () => {
    const record = (await readServerRecord(key, config)) || newServerRecord(config);
    record.value = value;
    record.base = undefined;
    record.dirty = true;
    await writeServerRecord(key, record);
    if (await syncServerRecord(key, config, record)) return record.remote;
    return mergeStoredValues(key, undefined, value, record.remote);
  });
}

// --- Kept partly on this phone: cert data, records, lab log ---
// These three are shared like the rest, but what this phone keeps of
// them on its own (to work offline) is only part of the team's:
//   cert data (certqr:history)    — all of it: worksheets need any
//                                    certificate, wherever they're done;
//   records   (certqr:uutDatabase) — the ones this phone saved or changed;
//   lab log   (certqr:labLog)      — the trips this phone took out or
//                                    brought back, and everything still
//                                    out (scanning something in with no
//                                    signal has to know it's out).
// Online, every page shows the team's whole list, fetched on each page
// load; offline, only what this phone keeps, and pages say so
// (isShowingOfflineCopy).
//
// Nothing is sent as a whole list. A change becomes a small step — put
// this item, add it if it isn't there, remove it — kept in a queue on
// the phone (record.ops) until the server has it. To send, the phone
// fetches the server's list as it is now, applies its steps to that,
// and saves the result on that version (or fetches again and re-applies
// if someone saved in between). So nobody's list can save over anyone
// else's, and the phone doesn't need the whole list to make a change.
//
// Deleting (removeScope): from this phone only, unless the person chose
// otherwise (askDeleteScope; Settings → "Ask to delete from the server
// too"). From this phone only, the item is hidden here — it stays on the
// server and on everyone else's phones, and "Show hidden items again" in
// Settings brings it back. For everyone, it's a remove step like any
// other, and the server's audit log says who.
//
// What's kept, per key, in IndexedDB under PARTIAL_PREFIX:
//   { scope, ownKeys, own, ops, hidden }
//     ownKeys — item keys this phone saved or changed
//     own     — the items kept offline (what's shown with no signal)
//     ops     — steps not yet on the server: { type: 'put' | 'add' |
//               'remove', key, item }
//     hidden  — item keys deleted from this phone only
const PARTIAL_KEYS = {
  'certqr:history': 'all',
  'certqr:uutDatabase': 'own',
  'certqr:labLog': 'own+out',
};
const PARTIAL_PREFIX = 'certqr-partial:';
const DELETE_FROM_SERVER_KEY = 'certqr:deleteFromServer';
// key → { record, snapshot: Map(itemKey → JSON), server: list|null, online }
const partialStates = new Map();
const partialRecordsInMemory = new Map();

function isPartialKey(key) {
  return Object.prototype.hasOwnProperty.call(PARTIAL_KEYS, key);
}

function partialItemKey(key, item) {
  const id = mergeItemKey(key)(item);
  return id == null ? `json:${JSON.stringify(item)}` : `id:${id}`;
}

function snapshotOf(key, list) {
  const map = new Map();
  (Array.isArray(list) ? list : []).forEach((item) => {
    const itemKey = partialItemKey(key, item);
    if (!map.has(itemKey)) map.set(itemKey, JSON.stringify(item));
  });
  return map;
}

// The list with the queued steps applied. New items go in front: these
// lists are kept newest first.
function applyPartialOps(key, list, ops) {
  const out = Array.isArray(list) ? list.slice() : [];
  ops.forEach((op) => {
    const index = out.findIndex((item) => partialItemKey(key, item) === op.key);
    if (op.type === 'remove') {
      if (index !== -1) out.splice(index, 1);
    } else if (op.type === 'put') {
      if (index !== -1) out[index] = op.item;
      else out.unshift(op.item);
    } else if (op.type === 'add' && index === -1) {
      out.unshift(op.item);
    }
  });
  return out;
}

// What this phone keeps offline of the server's list.
function keptOffline(key, record, list) {
  const mode = PARTIAL_KEYS[key];
  const items = Array.isArray(list) ? list : [];
  if (mode === 'all') return items.slice();
  const own = new Set(record.ownKeys);
  return items.filter((item) => own.has(partialItemKey(key, item)) || (mode === 'own+out' && item && !item.inAt));
}

function withoutHidden(key, record, list) {
  if (!record.hidden.length) return list;
  const hidden = new Set(record.hidden);
  return list.filter((item) => !hidden.has(partialItemKey(key, item)));
}

async function readPartialRecord(key, config) {
  let record = partialRecordsInMemory.get(key);
  try {
    record = (await idbGet(PARTIAL_PREFIX + key)) || record;
  } catch {
    // IndexedDB unavailable — the in-memory copy, if any.
  }
  if (!record || record.scope !== serverRecordScope(config)) return null;
  ['ownKeys', 'own', 'ops', 'hidden'].forEach((field) => {
    if (!Array.isArray(record[field])) record[field] = [];
  });
  return record;
}

async function writePartialRecord(key, record) {
  partialRecordsInMemory.set(key, record);
  try {
    await idbSet(PARTIAL_PREFIX + key, record);
  } catch {
    // Kept in memory only, for this page.
  }
}

function notePartialPending(key, record) {
  if (record.ops.length) serverDirtyKeys.add(key);
  else serverDirtyKeys.delete(key);
}

// The first time this key is read on this server since the update: from
// the whole list an earlier version of the app kept (its own changes
// still unsent become steps; what it keeps offline is guessed from who
// is named on each item), or, signing in for the first time, from what
// the phone held before (all of it its own, added where missing).
async function startPartialRecord(key, config) {
  const record = { scope: serverRecordScope(config), ownKeys: [], own: [], ops: [], hidden: [] };
  const old = await readServerRecord(key, config);
  if (old) {
    const value = Array.isArray(old.value) ? old.value : [];
    if (old.dirty) {
      const before = snapshotOf(key, old.base !== undefined ? old.base : old.remote);
      const after = snapshotOf(key, value);
      value.forEach((item) => {
        const itemKey = partialItemKey(key, item);
        if (before.get(itemKey) !== after.get(itemKey)) {
          record.ops.push({ type: 'put', key: itemKey, item });
          record.ownKeys.push(itemKey);
        }
      });
    }
    const me = String(config.userName || '').trim().toLowerCase();
    const mine = (name) => Boolean(me) && String(name || '').trim().toLowerCase() === me;
    value.forEach((item) => {
      if (!item) return;
      const isMine = key === 'certqr:uutDatabase' ? mine(item.technician) : key === 'certqr:labLog' ? mine(item.takenBy) || mine(item.returnedBy) : false;
      if (isMine) record.ownKeys.push(partialItemKey(key, item));
    });
    record.own = keptOffline(key, record, value);
    serverRecordsInMemory.delete(key);
    try {
      await idbDelete(SERVER_RECORD_PREFIX + key);
    } catch {
      // Read again next time; the steps are the same.
    }
  } else {
    const local = await readLocalValue(key);
    (Array.isArray(local) ? local : []).forEach((item) => {
      const itemKey = partialItemKey(key, item);
      record.ops.push({ type: 'add', key: itemKey, item });
      record.ownKeys.push(itemKey);
      record.own.push(item);
    });
  }
  record.ownKeys = [...new Set(record.ownKeys)];
  await writePartialRecord(key, record);
  return record;
}

async function fetchPartialList(key, config) {
  const { status, data } = await serverRequest(config, 'GET', `data/${serverCollectionName(key)}`, undefined, SERVER_READ_TIMEOUT_MS);
  if (status !== 200 || !data) throw serverFailure(status, data);
  return { list: data.exists && Array.isArray(data.value) ? data.value : [], version: data.exists ? data.version : null };
}

// Sends the queued steps onto `remote` (the server's list as just
// fetched). Resolves to the server's list afterwards; rejects when it
// can't be sent, the steps kept for next time.
async function pushPartialOps(key, config, record, remote) {
  let { list, version } = remote;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (record.ops.length === 0) return list;
    const applied = applyPartialOps(key, list, record.ops);
    if (sameJson(applied, list)) {
      record.ops = [];
      return list;
    }
    const { status, data } = await serverRequest(config, 'PUT', `data/${serverCollectionName(key)}`, { value: applied, baseVersion: version }, SERVER_WRITE_TIMEOUT_MS);
    if (status === 200 && data && typeof data.version === 'string') {
      noteSyncSent(key, describeServerChange(key, list, applied));
      record.ops = [];
      return applied;
    }
    if (status === 409 && data) {
      list = data.exists && Array.isArray(data.value) ? data.value : [];
      version = data.exists ? data.version : null;
      continue;
    }
    throw serverFailure(status, data);
  }
  throw new Error('Others kept saving at the same moment; will try again.');
}

// Fetches, sends what's queued, and keeps the server's list as this
// phone now knows it. Resolves to that list, or null when the server
// couldn't be reached (the steps stay queued).
async function syncPartialKey(key, config, record) {
  if (!serverReachable(config)) {
    noteServerFailure(record.ops.length ? key : null, null);
    return null;
  }
  try {
    const latest = await pushPartialOps(key, config, record, await fetchPartialList(key, config));
    record.own = keptOffline(key, record, latest);
    await writePartialRecord(key, record);
    notePartialPending(key, record);
    noteServerSynced(record.ops.length ? null : key);
    return latest;
  } catch (err) {
    await writePartialRecord(key, record);
    noteServerFailure(record.ops.length ? key : null, err);
    return null;
  }
}

// Once per page: read again, it would set the page's lists back to
// what the server had, under changes the page has made since.
const partialHydrating = new Map();

function hydratePartialKey(key, config) {
  if (partialStates.has(key)) return Promise.resolve();
  if (!partialHydrating.has(key)) {
    partialHydrating.set(key, loadPartialKey(key, config).finally(() => partialHydrating.delete(key)));
  }
  return partialHydrating.get(key);
}

async function loadPartialKey(key, config) {
  await withServerKeyLock(key, async () => {
    const record = (await readPartialRecord(key, config)) || (await startPartialRecord(key, config));
    notePartialPending(key, record);
    const latest = await syncPartialKey(key, config, record);
    const shown = withoutHidden(key, record, latest || record.own);
    partialStates.set(key, { record, snapshot: snapshotOf(key, shown), server: latest, online: Boolean(latest) });
    storageCache.set(key, shown);
  });
}

// --- Deleting from this phone or from the server ---
// The next removal written (writeStore) is for this phone only unless
// set otherwise just before it. Read once, then back to this phone only.
let nextRemovalScope = 'local';

function setRemovalScope(scope) {
  nextRemovalScope = scope === 'everyone' ? 'everyone' : 'local';
  // For the write that follows straight away, and no later one.
  setTimeout(() => {
    nextRemovalScope = 'local';
  }, 0);
}

function deleteAsksAboutServer() {
  try {
    return localStorage.getItem(DELETE_FROM_SERVER_KEY) === '1';
  } catch {
    return false;
  }
}

function setDeleteAsksAboutServer(on) {
  try {
    if (on) localStorage.setItem(DELETE_FROM_SERVER_KEY, '1');
    else localStorage.removeItem(DELETE_FROM_SERVER_KEY);
  } catch {
    // Not remembered: deleting stays this-phone-only.
  }
}

// Asks, where it applies, whether a delete is for this phone only or
// for everyone, and sets it for the removal that follows — which has to
// be written straight after this resolves. Resolves to 'local',
// 'everyone', or null when cancelled. Not signed in to a shared server,
// or with the setting off, it asks `question` as a plain confirm when
// `confirmFirst` (the page asked before deleting anyway).
function askDeleteScope(question, confirmFirst = true) {
  const config = loadServerConfig();
  if (!config || !deleteAsksAboutServer()) {
    if (question && confirmFirst && !window.confirm(question)) return Promise.resolve(null);
    setRemovalScope('local');
    return Promise.resolve('local');
  }
  return new Promise((resolve) => {
    const dialog = document.createElement('div');
    dialog.className = 'delete-scope';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const box = document.createElement('div');
    box.className = 'delete-scope-box';
    const heading = document.createElement('p');
    heading.className = 'delete-scope-title';
    heading.textContent = question || 'Delete this?';
    const note = document.createElement('p');
    note.className = 'delete-scope-note';
    note.textContent = 'From this phone only, it stays on the server and on everyone else\'s phones. For everyone, it\'s removed from the server.';
    box.append(heading, note);
    const finish = (scope) => {
      dialog.remove();
      if (scope) setRemovalScope(scope);
      resolve(scope);
    };
    [['This phone only', 'local', 'delete-scope-btn'], ['Delete for everyone', 'everyone', 'delete-scope-btn delete-scope-everyone'], ['Cancel', null, 'delete-scope-btn delete-scope-cancel']].forEach(([label, scope, className]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = className;
      btn.textContent = label;
      btn.addEventListener('click', () => finish(scope));
      box.appendChild(btn);
    });
    dialog.appendChild(box);
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) finish(null);
    });
    document.body.appendChild(dialog);
    box.querySelector('button').focus();
  });
}

// A page has written its whole list: what changed, against what it was
// shown, becomes steps (and hidden items, for a removal from this phone
// only). Done at once, so the removal scope set just before applies.
// `addOnly`: a list written without having been read first, which can
// only add or change.
function notePartialWrite(key, value, addOnly) {
  const state = partialStates.get(key);
  if (!state) return false;
  const { record } = state;
  const scope = nextRemovalScope;
  nextRemovalScope = 'local';
  const after = snapshotOf(key, value);
  const own = new Set(record.ownKeys);
  const removedKeys = new Set();
  after.forEach((json, itemKey) => {
    if (state.snapshot.get(itemKey) === json) return;
    const item = JSON.parse(json);
    record.ops.push({ type: 'put', key: itemKey, item });
    own.add(itemKey);
  });
  if (!addOnly) {
    // An item from before items had ids, given one (ensureRecordIds): the
    // same item, so the one without is replaced everywhere, not hidden.
    const withoutId = (json) => {
      const item = JSON.parse(json);
      if (!item || typeof item !== 'object' || Array.isArray(item)) return json;
      const { id, ...rest } = item;
      return JSON.stringify(rest);
    };
    const givenIds = new Set();
    after.forEach((json, itemKey) => {
      if (!state.snapshot.has(itemKey)) givenIds.add(withoutId(json));
    });
    state.snapshot.forEach((json, itemKey) => {
      if (after.has(itemKey)) return;
      removedKeys.add(itemKey);
      own.delete(itemKey);
      const replaced = itemKey.startsWith('json:') && givenIds.has(withoutId(json));
      if (scope === 'everyone' || replaced) record.ops.push({ type: 'remove', key: itemKey, item: JSON.parse(json) });
      else if (!record.hidden.includes(itemKey)) record.hidden.push(itemKey);
    });
  }
  record.ownKeys = [...own];
  // What's kept offline follows at once; the next sync tidies it. Cert
  // data keeps everything, a hidden scan included (it's only not shown);
  // records and the lab log let go of what's deleted here.
  const puts = record.ops.filter((op) => op.type !== 'remove');
  const keepRemoved = PARTIAL_KEYS[key] === 'all' && scope !== 'everyone';
  const kept = applyPartialOps(key, record.own, puts).filter((item) => keepRemoved || !removedKeys.has(partialItemKey(key, item)));
  record.own = keptOffline(key, record, kept);
  state.snapshot = addOnly ? new Map([...state.snapshot, ...after]) : after;
  notePartialPending(key, record);
  return true;
}

async function persistPartialValue(key, value, config) {
  if (!partialStates.has(key)) {
    // Written before being read on this page: read first, then only
    // what was added or changed counts.
    await hydratePartialKey(key, config);
    notePartialWrite(key, value, true);
  }
  await withServerKeyLock(key, async () => {
    const state = partialStates.get(key);
    await writePartialRecord(key, state.record);
    const latest = await syncPartialKey(key, config, state.record);
    if (latest) {
      state.server = latest;
      state.online = true;
    }
  });
}

// A restore while connected: everything in the backup is added where
// it's missing, and kept on this phone. Resolves to what's now shown.
async function restorePartialValue(key, value, config) {
  if (!partialStates.has(key)) await hydratePartialKey(key, config);
  const state = partialStates.get(key);
  (Array.isArray(value) ? value : []).forEach((item) => {
    const itemKey = partialItemKey(key, item);
    state.record.ops.push({ type: 'add', key: itemKey, item });
    if (!state.record.ownKeys.includes(itemKey)) state.record.ownKeys.push(itemKey);
    state.record.hidden = state.record.hidden.filter((hiddenKey) => hiddenKey !== itemKey);
  });
  state.record.own = applyPartialOps(key, state.record.own, state.record.ops.filter((op) => op.type === 'add'));
  await withServerKeyLock(key, async () => {
    await writePartialRecord(key, state.record);
    await syncPartialKey(key, config, state.record);
  });
  partialStates.delete(key);
  await hydratePartialKey(key, config);
  return storageCache.get(key);
}

async function flushPartialKey(key, config) {
  await withServerKeyLock(key, async () => {
    const state = partialStates.get(key);
    const record = state ? state.record : await readPartialRecord(key, config);
    if (record && record.ops.length) await syncPartialKey(key, config, record);
  });
}

// A line at the top of `container` while any of `keys` is showing only
// this phone's own copy; taken away when it isn't.
function noteOfflineCopy(container, keys) {
  if (!container) return;
  let note = container.querySelector(':scope > .offline-copy-note');
  if (!isShowingOfflineCopy(keys)) {
    if (note) note.remove();
    return;
  }
  if (!note) {
    note = document.createElement('p');
    note.className = 'offline-copy-note';
    note.setAttribute('role', 'status');
    container.insertBefore(note, container.firstChild);
  }
  note.textContent = 'Offline — showing what is saved on this phone. Everyone else\'s shows again once you are back online.';
}

// Whether any of `keys` is showing only this phone's own copy (offline,
// or the server couldn't be reached when the page loaded).
function isShowingOfflineCopy(keys) {
  return keys.some((key) => {
    const state = partialStates.get(key);
    return Boolean(state && !state.online);
  });
}

// For Settings: { key: { kept, hidden, waiting, server } } — what this
// phone keeps offline, has hidden, and has still to send, and how many
// the server has (null when not fetched on this page).
async function partialStorageCounts() {
  const config = loadServerConfig();
  const counts = {};
  for (const key of Object.keys(PARTIAL_KEYS)) {
    const state = partialStates.get(key);
    const record = state ? state.record : config && (await readPartialRecord(key, config));
    if (!record) continue;
    counts[key] = {
      kept: withoutHidden(key, record, record.own).length,
      hidden: record.hidden.length,
      waiting: record.ops.length,
      server: state && state.server ? state.server.length : null,
    };
  }
  return counts;
}

// Settings → "Show hidden items again": everything deleted from this
// phone only shows again (from the next page load).
async function showHiddenItems() {
  const config = loadServerConfig();
  if (!config) return;
  for (const key of Object.keys(PARTIAL_KEYS)) {
    await withServerKeyLock(key, async () => {
      const state = partialStates.get(key);
      const record = state ? state.record : await readPartialRecord(key, config);
      if (!record || !record.hidden.length) return;
      record.hidden = [];
      await writePartialRecord(key, record);
    });
  }
}

// What's queued for the Sync Log's "Waiting to send".
function describePartialOps(key, record) {
  const state = partialStates.get(key);
  const onServer = new Set(((state && state.server) || []).map((item) => partialItemKey(key, item)));
  const change = { added: [], changed: [], removed: [], updated: false };
  const seen = new Set();
  record.ops.slice().reverse().forEach((op) => {
    if (seen.has(op.key)) return;
    seen.add(op.key);
    const label = syncItemLabel(key, op.item);
    if (op.type === 'remove') change.removed.push(label);
    else if (op.type === 'put' && onServer.has(op.key)) change.changed.push(label);
    else change.added.push(label);
  });
  return change;
}

// Sends whatever is still waiting, for every collection.
let serverFlushRunning = null;

function flushServerQueue() {
  const config = loadServerConfig();
  if (!config || config.signedOut) return Promise.resolve();
  if (serverFlushRunning) return serverFlushRunning;
  serverFlushRunning = (async () => {
    for (const key of Object.keys(SERVER_COLLECTIONS)) {
      if (isPartialKey(key)) {
        await flushPartialKey(key, config);
        continue;
      }
      await withServerKeyLock(key, async () => {
        const record = await readServerRecord(key, config);
        if (record && record.dirty) await syncServerRecord(key, config, record);
      });
    }
  })().finally(() => {
    serverFlushRunning = null;
  });
  return serverFlushRunning;
}

// Connects this device — or signs it in again after it was signed out —
// then loads every collection, which puts what this device already held
// together with the server's, and sends anything left waiting.
async function connectServer(urlInput, loginId, password, options = {}) {
  const url = normalizeServerUrl(urlInput);
  const id = String(loginId || '').trim().toLowerCase();
  if (!id) throw new Error('Enter your login ID.');
  if (!password) throw new Error('Enter your password.');
  const user = await signInToServer(url, id, password);
  return finishServerSignIn(url, user, { ...options, verifier: await makePasswordVerifier(password) });
}

// Signed in by the server: becomes this phone's account (another one
// signed in here is put aside with its data: activateAccount), then
// everything is loaded and sent. `options`: { remember, verifier }.
async function finishServerSignIn(url, user, options = {}) {
  await activateAccount({ url, token: user.token, userId: user.id, userName: user.name, admin: user.admin }, options);
  setServerStatus({ state: 'online', message: '' });
  await hydrateStorage(Object.keys(SERVER_COLLECTIONS));
  await flushServerQueue();
  // The name as the server has it now; the sign-in has worked without it.
  try {
    await refreshServerAccount();
  } catch {
    // Fetched again on a later page.
  }
  // Photos already on this phone go up too, in the background (photos.js,
  // on the pages that load it).
  if (typeof syncPhotosWithServer === 'function') syncPhotosWithServer(true).catch(() => {});
  return user;
}

// --- Invites ---
// An admin makes a one-time invite for a person (createServerInvite);
// it's shown as a QR code, or sent as a link, of the form
//   https://<server>/join#id=<login ID>&invite=<code>
// The person scans it in Settings (or pastes the link there), chooses a
// password, and is signed in (acceptServerInvite). Opened in a browser
// instead, /join is a page saying to use the app; the part after # is
// never sent to the server.
async function createServerInvite(id) {
  const config = loadServerConfig();
  const data = await serverAccountRequest('POST', `admin/users/${encodeURIComponent(id)}/invite`);
  if (!data || typeof data.invite !== 'string') throw new Error('The server didn\'t make an invite.');
  const link = `${config.url}/join#${new URLSearchParams({ id, invite: data.invite }).toString()}`;
  return { link, expiresAt: data.expiresAt };
}

// From an invite's text, { url, id, invite }; from a sign-in QR's (see
// createServerTransfer), { url, id, transfer }; or null if it's neither.
function parseServerInvite(text) {
  let link;
  try {
    link = new URL(String(text || '').trim());
  } catch {
    return null;
  }
  if (!/\/join$/.test(link.pathname)) return null;
  const params = new URLSearchParams(link.hash.replace(/^#/, ''));
  const id = String(params.get('id') || '').trim().toLowerCase();
  const invite = String(params.get('invite') || '');
  const transfer = String(params.get('transfer') || '');
  if (!id || (!invite && !transfer)) return null;
  let url;
  try {
    url = normalizeServerUrl(`${link.origin}${link.pathname.replace(/\/join$/, '')}`);
  } catch {
    return null;
  }
  return invite ? { url, id, invite } : { url, id, transfer };
}

async function acceptServerInvite(invite, password, options = {}) {
  if (!password) throw new Error('Choose a password.');
  const user = await postSignIn(invite.url, 'invite/accept', { id: invite.id, invite: invite.invite, password });
  return finishServerSignIn(invite.url, user, { ...options, verifier: await makePasswordVerifier(password) });
}

// --- Moving to another phone ---
// On a signed-in phone, a one-time sign-in QR (createServerTransfer):
//   https://<server>/join#id=<login ID>&transfer=<code>
// Scanned in Settings on the other phone, it signs that phone in as the
// same person, no password typed (acceptServerTransfer). It works once,
// within 10 minutes.
async function createServerTransfer() {
  const config = loadServerConfig();
  const data = await serverAccountRequest('POST', 'me/transfer');
  if (!data || typeof data.transfer !== 'string') throw new Error('The server didn\'t make a sign-in QR. It may need updating.');
  const link = `${config.url}/join#${new URLSearchParams({ id: config.userId, transfer: data.transfer }).toString()}`;
  return { link, expiresAt: data.expiresAt };
}

// No password typed: one kept from an earlier sign-in here stays.
async function acceptServerTransfer(transfer, options = {}) {
  const user = await postSignIn(transfer.url, 'transfer/accept', { id: transfer.id, transfer: transfer.transfer });
  return finishServerSignIn(transfer.url, user, options);
}

// --- This person's account, and (admins) everyone's ---
// Each resolves to what the server sent back, or rejects with a message
// fit to show.
async function serverAccountRequest(method, path, body) {
  const config = loadServerConfig();
  if (!config) throw new Error('Not connected to a shared server.');
  if (config.signedOut) throw new Error('Signed out. Sign in again first.');
  let response;
  try {
    response = await serverRequest(config, method, path, body, SERVER_WRITE_TIMEOUT_MS);
  } catch {
    throw new Error('Couldn\'t reach the server. Check the connection.');
  }
  const { status, data } = response;
  if (status === 401) {
    noteServerFailure(null, serverFailure(401, data));
    throw new Error('Signed out. Sign in again.');
  }
  if (status !== 200) throw new Error((data && data.error) || `The server answered ${status}.`);
  return data;
}

// This person's name and whether they can manage people (an admin may
// have been made one, or stopped being one, since signing in):
// loadSettings uses the name as the technician. Pages showing it hear
// 'certqr:server-account' when it's been fetched.
const SERVER_ACCOUNT_REFRESH_MS = 5 * 60 * 1000;

async function refreshServerAccount() {
  const me = await serverAccountRequest('GET', 'me');
  const config = loadServerConfig();
  if (config && me && typeof me.id === 'string') {
    const { people, ...kept } = config;
    saveServerConfig({ ...kept, userName: String(me.name || me.id), admin: Boolean(me.admin), accountAt: new Date().toISOString() });
    window.dispatchEvent(new CustomEvent('certqr:server-account'));
  }
  return loadServerConfig();
}

// Signed in to a shared server: the technician is whoever is signed in,
// and nobody else is offered. Not signed in: null, to use this phone's
// own.
function serverSettingsPeople() {
  const config = loadServerConfig();
  if (!config) return null;
  return {
    technician: String(config.userName || config.userId || ''),
    people: [],
  };
}

// Your own name on the server: the technician on your worksheets and
// "Taken by" on the Lab Log.
async function changeServerName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Enter your name.');
  const me = await serverAccountRequest('PUT', 'me', { name: trimmed });
  const config = loadServerConfig();
  if (config && me && typeof me.name === 'string') {
    saveServerConfig({ ...config, userName: me.name });
    window.dispatchEvent(new CustomEvent('certqr:server-account'));
  }
  return loadServerConfig();
}

async function changeServerPassword(current, password) {
  const data = await serverAccountRequest('POST', 'me/password', { current, password });
  // Signing in here with no connection takes the new password from now on.
  const config = loadServerConfig();
  if (config) updateSavedAccount(config, { verifier: await makePasswordVerifier(password) });
  return data;
}

async function listServerPeople() {
  const data = await serverAccountRequest('GET', 'admin/users');
  return data && Array.isArray(data.users) ? data.users : [];
}

// One month of the server's audit log (admins only; dashboard.js):
// { month, months, summary, total, entries }. `filters` is
// { month, user, kind, offset, limit }, each optional.
function loadServerAudit(filters) {
  const query = new URLSearchParams();
  Object.entries(filters || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  });
  const text = query.toString();
  return serverAccountRequest('GET', `admin/audit${text ? `?${text}` : ''}`);
}

function addServerPerson(person) {
  return serverAccountRequest('POST', 'admin/users', person);
}

function updateServerPerson(id, changes) {
  return serverAccountRequest('PUT', `admin/users/${encodeURIComponent(id)}`, changes);
}

function removeServerPerson(id) {
  return serverAccountRequest('DELETE', `admin/users/${encodeURIComponent(id)}`);
}

// How many collections still have changes the server hasn't got.
async function countUnsentServerChanges() {
  const config = loadServerConfig();
  if (!config) return 0;
  let count = 0;
  for (const key of Object.keys(SERVER_COLLECTIONS)) {
    if (isPartialKey(key)) {
      const state = partialStates.get(key);
      const partial = state ? state.record : await readPartialRecord(key, config);
      if (partial && partial.ops.length) count += 1;
      continue;
    }
    const record = await readServerRecord(key, config);
    if (record && record.dirty) count += 1;
  }
  return count;
}

// What hasn't reached the server yet, collection by collection:
// [{ key, added, changed, removed, updated }] (see describeServerChange).
async function listUnsentServerChanges() {
  const config = loadServerConfig();
  if (!config) return [];
  const unsent = [];
  for (const key of Object.keys(SERVER_COLLECTIONS)) {
    if (isPartialKey(key)) {
      const state = partialStates.get(key);
      const partial = state ? state.record : await readPartialRecord(key, config);
      if (partial && partial.ops.length) unsent.push({ key, ...describePartialOps(key, partial) });
      continue;
    }
    const record = await readServerRecord(key, config);
    if (!record || !record.dirty) continue;
    const change = describeServerChange(key, record.base !== undefined ? record.base : record.remote, record.value);
    // Dirty but no different (put back as it was): still waiting to be
    // confirmed, so still listed.
    if (!change.added.length && !change.changed.length && !change.removed.length) change.updated = true;
    unsent.push({ key, ...change });
  }
  return unsent;
}

// --- Sync log ---
// What this phone has sent to the shared server (synclog.html): one
// entry each time a change is accepted, naming what was added, changed
// or removed. Kept in localStorage, not with the data: it's about this
// phone. Changes to the same collection within a few minutes are put
// together in one entry, so typing in a worksheet isn't a hundred lines.
const SYNC_LOG_KEY = 'certqr:syncLog';
const SYNC_LOG_MAX = 300;
const SYNC_LOG_LABELS_MAX = 30;
const SYNC_LOG_JOIN_MS = 5 * 60 * 1000;
const SYNC_COLLECTION_LABELS = {
  'certqr:history': 'Cert data',
  'certqr:uutDatabase': 'Records',
  'certqr:labLog': 'Lab log',
  'certqr:customers': 'Customer folders',
  'certqr:shareLog': 'Shared log',
  'certqr:worksheetTemplates': 'Worksheet templates',
  'certqr:interpTabs': 'Open worksheets',
  'certqr:settings': 'Settings',
  'certqr:converter': 'Converter',
  photos: 'Photos',
};

function syncCollectionLabel(key) {
  return SYNC_COLLECTION_LABELS[key] || key;
}

// A name for one item of a list, as a person would know it.
function syncItemLabel(key, item) {
  if (!item || typeof item !== 'object') return String(item);
  if (key === 'certqr:history') return [item.id, item.name].filter(Boolean).join(' — ') || 'Scan';
  if (key === 'certqr:uutDatabase') return formatUutLabel(item.uutModel, item.uutSerial) || 'Worksheet';
  if (key === 'certqr:labLog') {
    const what = [item.equipmentId, item.equipmentName].filter(Boolean).join(' — ') || 'Equipment';
    return item.inAt ? `${what} (back in)` : `${what} (out)`;
  }
  if (key === 'certqr:customers') return item.name || 'Folder';
  if (key === 'certqr:worksheetTemplates') return item.name || 'Template';
  if (key === 'certqr:shareLog') return item.title || 'Share';
  return item.name || item.title || item.id || 'Item';
}

// What `value` holds that `before` didn't: { added, changed, removed }
// as names, and `updated` for something that isn't a list (settings,
// open worksheets), which has changed as a whole.
function describeServerChange(key, before, value) {
  const change = { added: [], changed: [], removed: [], updated: false };
  if (!Array.isArray(value)) {
    change.updated = value !== undefined && !sameJson(before, value);
    return change;
  }
  const keyOf = mergeItemKey(key);
  const keyFor = (item) => {
    const itemKey = keyOf(item);
    return itemKey == null ? `json:${JSON.stringify(item)}` : `id:${itemKey}`;
  };
  const was = new Map((Array.isArray(before) ? before : []).map((item) => [keyFor(item), item]));
  const now = new Map(value.map((item) => [keyFor(item), item]));
  now.forEach((item, itemKey) => {
    if (!was.has(itemKey)) change.added.push(syncItemLabel(key, item));
    else if (!sameJson(was.get(itemKey), item)) change.changed.push(syncItemLabel(key, item));
  });
  was.forEach((item, itemKey) => {
    if (!now.has(itemKey)) change.removed.push(syncItemLabel(key, item));
  });
  return change;
}

function loadSyncLog() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SYNC_LOG_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSyncLog(entries) {
  try {
    localStorage.setItem(SYNC_LOG_KEY, JSON.stringify(entries.slice(0, SYNC_LOG_MAX)));
  } catch {
    // Full: the log is a convenience, the data itself went.
  }
  try {
    window.dispatchEvent(new CustomEvent('certqr:sync-log'));
  } catch {
    // no-op
  }
}

function addUnique(list, names) {
  names.forEach((name) => {
    if (!list.includes(name)) list.push(name);
  });
  return list.slice(0, SYNC_LOG_LABELS_MAX);
}

// Notes that `change` (describeServerChange's) reached the server.
// `photos` is a number of photos sent, which have no names to show.
function noteSyncSent(key, change, photos) {
  try {
    if (!photos && !change.added.length && !change.changed.length && !change.removed.length && !change.updated) return;
    const entries = loadSyncLog();
    const now = Date.now();
    const recent = entries.find((entry) => entry.key === key && now - Date.parse(entry.at) < SYNC_LOG_JOIN_MS);
    const entry = recent || {
      id: `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      key,
      added: [],
      changed: [],
      removed: [],
      updated: false,
    };
    entry.at = new Date(now).toISOString();
    entry.added = addUnique(entry.added, change.added);
    // Added and then changed in the same few minutes is still "added".
    entry.changed = addUnique(entry.changed, change.changed.filter((name) => !entry.added.includes(name)));
    entry.removed = addUnique(entry.removed, change.removed);
    entry.updated = entry.updated || change.updated;
    if (photos) entry.photos = (entry.photos || 0) + photos;
    // At the top either way: it's the newest now.
    saveSyncLog([entry, ...entries.filter((other) => other !== recent)]);
  } catch {
    // The log is a convenience; what was sent was sent.
  }
}

// --- Accounts on this phone ---
// Like a browser's profiles: everyone who has signed in on this phone is
// remembered here (on the phone, never on the server), and can come
// back, or be switched to, with their password (login.html). Each
// account's data on the phone is its own: switching puts the one signed
// in aside — its offline copy, the changes it still has to send, its
// open worksheets, Sync Log and photo queue — and brings back the
// other's.
//
//   localStorage certqr:accounts — [{ scope, url, userId, userName,
//       admin, remember, lastAt, verifier, config }]
//     verifier — a salted PBKDF2 hash of the password (never the
//                password), so it can be checked with no connection
//     config   — the server's sign-in of an account put aside
//   localStorage certqr:server — the account signed in now, with
//     `remember` ("Remember me")
//   sessionStorage certqr:session — the account signed into since the
//     app was opened. Without "Remember me" the password is asked again
//     once the app has been closed (login-gate.js).
//   IndexedDB certqr-account:<scope> — an account's data, put aside.
const ACCOUNTS_KEY = 'certqr:accounts';
const SESSION_KEY = 'certqr:session';
const ACCOUNT_DATA_PREFIX = 'certqr-account:';
// Besides the shared collections, what each account has of its own here.
const ACCOUNT_LOCAL_VALUES = ['certqr:interpTabs'];
const ACCOUNT_LOCAL_STORAGE = ['certqr:syncLog', 'certqr:photoUploads', 'certqr:photoCheckedAt', 'certqr:pendingConfirmLog'];
const PASSWORD_ITERATIONS = 100000;

function accountScope(config) {
  return serverRecordScope(config);
}

function loadSavedAccounts() {
  try {
    const list = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]');
    return Array.isArray(list) ? list.filter((a) => a && typeof a.scope === 'string' && typeof a.url === 'string' && typeof a.userId === 'string') : [];
  } catch {
    return [];
  }
}

function saveSavedAccounts(list) {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
  } catch {
    // Storage full: the list is a convenience; signing in still works.
  }
}

// Adds or updates the account `config` is signed in as. `extra` sets
// more of its fields (remember, lastAt, verifier, config).
function updateSavedAccount(config, extra = {}) {
  if (!config || typeof config.url !== 'string' || !config.userId) return;
  const scope = accountScope(config);
  const list = loadSavedAccounts();
  const index = list.findIndex((a) => a.scope === scope);
  const entry = index === -1 ? { scope, lastAt: new Date().toISOString() } : list[index];
  const next = { ...entry, url: config.url, userId: config.userId, userName: String(config.userName || entry.userName || config.userId), admin: Boolean(config.admin), ...extra };
  if (index === -1) list.push(next);
  else list[index] = next;
  saveSavedAccounts(list);
}

// For the login page, the most recently used first; no tokens or
// password hashes in it.
function listSavedAccounts() {
  const active = loadServerConfig();
  const activeScope = active ? accountScope(active) : null;
  return loadSavedAccounts()
    .map((a) => ({
      scope: a.scope,
      url: a.url,
      userId: a.userId,
      userName: a.userName || a.userId,
      admin: Boolean(a.admin),
      remember: a.remember !== false,
      lastAt: a.lastAt || '',
      active: a.scope === activeScope,
      signedOut: a.scope === activeScope ? Boolean(active.signedOut) : Boolean(a.config && a.config.signedOut),
      offlineReady: Boolean(a.verifier && (a.scope === activeScope || a.config)),
    }))
    .sort((a, b) => (b.active - a.active) || b.lastAt.localeCompare(a.lastAt));
}

// --- The password, kept for signing in with no connection ---
// (bytesToBase64 is further down; base64 back to bytes here, as
// updater.js has its own.)
function passwordBytes(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function derivePasswordHash(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

// Null where the browser can't (a page on plain http): that account then
// signs in only with a connection.
async function makePasswordVerifier(password) {
  try {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await derivePasswordHash(password, salt, PASSWORD_ITERATIONS);
    return { salt: bytesToBase64(salt), hash: bytesToBase64(hash), iterations: PASSWORD_ITERATIONS };
  } catch {
    return null;
  }
}

async function checkPasswordVerifier(verifier, password) {
  if (!verifier || !password) return false;
  try {
    const hash = await derivePasswordHash(password, passwordBytes(verifier.salt), verifier.iterations || PASSWORD_ITERATIONS);
    const want = passwordBytes(verifier.hash);
    let diff = hash.length ^ want.length;
    for (let i = 0; i < Math.min(hash.length, want.length); i += 1) diff |= hash[i] ^ want[i];
    return diff === 0;
  } catch {
    return false;
  }
}

// --- Putting an account's data aside, and bringing it back ---
async function settleWrites() {
  for (let i = 0; i < 200 && (activeWriters.size > 0 || pendingWrites.size > 0); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function idbGetOrNothing(key) {
  try {
    return await idbGet(key);
  } catch {
    return undefined;
  }
}

async function readParkedAccount(scope) {
  return (await idbGetOrNothing(ACCOUNT_DATA_PREFIX + scope)) || null;
}

// Everything of the signed-in account's on this phone, into one record
// of its own; then cleared, so the next account starts from nothing of
// it. What this phone held before anyone signed in was taken by the
// first account (startPartialRecord, hydrateServerKey), so it's cleared
// too, not given to the next one as well.
async function parkActiveAccount(config) {
  const scope = accountScope(config);
  const bundle = { scope, at: new Date().toISOString(), partial: {}, server: {}, local: {}, storage: {} };
  for (const key of Object.keys(SERVER_COLLECTIONS)) {
    const partial = (await idbGetOrNothing(PARTIAL_PREFIX + key)) || partialRecordsInMemory.get(key);
    if (partial && partial.scope === scope) bundle.partial[key] = partial;
    const record = (await idbGetOrNothing(SERVER_RECORD_PREFIX + key)) || serverRecordsInMemory.get(key);
    if (record && record.scope === scope) bundle.server[key] = record;
    // Not opened with this account yet: what the phone held is still to
    // be taken by it, so it goes with it.
    if (!bundle.partial[key] && !bundle.server[key]) {
      const value = await readLocalValue(key);
      if (value != null) bundle.local[key] = value;
    }
  }
  for (const key of ACCOUNT_LOCAL_VALUES) {
    const value = await readLocalValue(key);
    if (value != null) bundle.local[key] = value;
  }
  ACCOUNT_LOCAL_STORAGE.forEach((key) => {
    const value = localStorage.getItem(key);
    if (value != null) bundle.storage[key] = value;
  });
  try {
    await idbSet(ACCOUNT_DATA_PREFIX + scope, bundle);
  } catch {
    throw new Error('Couldn\'t put this account\'s data aside on this phone, so it is still signed in.');
  }
  for (const key of Object.keys(SERVER_COLLECTIONS)) {
    await idbDelete(PARTIAL_PREFIX + key).catch(() => {});
    await idbDelete(SERVER_RECORD_PREFIX + key).catch(() => {});
    await persistLocalValue(key, null);
  }
  for (const key of ACCOUNT_LOCAL_VALUES) await persistLocalValue(key, null);
  ACCOUNT_LOCAL_STORAGE.forEach((key) => localStorage.removeItem(key));
  partialStates.clear();
  partialRecordsInMemory.clear();
  serverRecordsInMemory.clear();
  serverDirtyKeys.clear();
  storageCache.clear();
}

// The account's data as it was put aside. With none (an account new to
// this phone) nothing is touched.
async function restoreParkedAccount(scope) {
  const bundle = await readParkedAccount(scope);
  if (!bundle) return;
  for (const key of Object.keys(SERVER_COLLECTIONS)) {
    if (bundle.partial && bundle.partial[key]) await writePartialRecord(key, bundle.partial[key]);
    if (bundle.server && bundle.server[key]) await writeServerRecord(key, bundle.server[key]);
  }
  for (const [key, value] of Object.entries(bundle.local || {})) {
    if (ACCOUNT_LOCAL_VALUES.includes(key) || serverCollectionName(key)) await persistLocalValue(key, value);
  }
  Object.entries(bundle.storage || {}).forEach(([key, value]) => {
    if (ACCOUNT_LOCAL_STORAGE.includes(key)) localStorage.setItem(key, value);
  });
  await idbDelete(ACCOUNT_DATA_PREFIX + scope).catch(() => {});
}

// A sign-in that's been replaced stops working on the server too.
function forgetServerSession(config) {
  if (!config || !config.token || config.signedOut || navigator.onLine === false) return;
  serverRequest(config, 'POST', 'logout', undefined, SERVER_READ_TIMEOUT_MS).catch(() => {});
}

// Sends what it can first (a few seconds at most); what's left waits
// with the account's data, and goes when it's signed in again.
async function putActiveAccountAside(active) {
  if (serverReachable(active)) {
    try {
      await Promise.race([flushServerQueue(), new Promise((resolve) => setTimeout(resolve, 8000))]);
    } catch {
      // Kept, and sent later.
    }
  }
  await settleWrites();
  await parkActiveAccount(active);
  updateSavedAccount(active, { config: { ...active } });
  localStorage.removeItem(SERVER_CONFIG_KEY);
  setServerStatus({ state: 'off', message: '', lastSyncAt: null });
}

// Makes `config` this phone's account: the one signed in (if another)
// is put aside, this one's own data brought back, and it's remembered.
// `options`: { remember, verifier }.
async function activateAccount(config, options = {}) {
  const scope = accountScope(config);
  const active = loadServerConfig();
  const activeScope = active ? accountScope(active) : null;
  const saved = loadSavedAccounts().find((a) => a.scope === scope) || null;
  if (active && activeScope !== scope) await putActiveAccountAside(active);
  if (activeScope !== scope) await restoreParkedAccount(scope);
  const previous = activeScope === scope ? active : saved && saved.config;
  if (previous && previous.token !== config.token) forgetServerSession(previous);
  const remember = options.remember === undefined ? !saved || saved.remember !== false : Boolean(options.remember);
  const { signedOut, ...signedIn } = config;
  const next = { ...signedIn, remember };
  localStorage.setItem(SERVER_CONFIG_KEY, JSON.stringify(next));
  const extra = { remember, lastAt: new Date().toISOString(), config: null };
  if (options.verifier) extra.verifier = options.verifier;
  updateSavedAccount(next, extra);
  try {
    sessionStorage.setItem(SESSION_KEY, scope);
  } catch {
    // No session storage: asked for the password again on the next page.
  }
  return next;
}

// The login page's "Sign in": with the server when it can be reached;
// otherwise, for an account that has signed in here before, with the
// password kept here (its changes go once there's a connection).
// Resolves to { config, offline }.
async function signInToAccount(urlInput, loginId, password, options = {}) {
  const url = normalizeServerUrl(urlInput);
  const id = String(loginId || '').trim().toLowerCase();
  if (!id) throw new Error('Enter your login ID.');
  if (!password) throw new Error('Enter your password.');
  try {
    const user = await signInToServer(url, id, password);
    await finishServerSignIn(url, user, { ...options, verifier: await makePasswordVerifier(password) });
    return { config: loadServerConfig(), offline: false };
  } catch (err) {
    if (!err.unreachable) throw err;
  }
  const scope = `${url}|${id}`;
  const saved = loadSavedAccounts().find((a) => a.scope === scope);
  const active = loadServerConfig();
  const config = active && accountScope(active) === scope ? active : saved && saved.config;
  if (!saved || !saved.verifier || !config) {
    throw new Error('Couldn\'t reach the server. With no connection, only an account that has signed in on this phone with its password before can sign in.');
  }
  if (config.signedOut) throw new Error('Couldn\'t reach the server, and this account was signed out by the server (password changed?). Sign in with a connection.');
  if (!(await checkPasswordVerifier(saved.verifier, password))) throw new Error('Wrong password.');
  await activateAccount(config, options);
  setServerStatus({ state: 'offline', message: '' });
  return { config: loadServerConfig(), offline: true };
}

// Signs this phone out: the account and its data stay here, put aside,
// for its password to bring back (login.html).
async function signOutAccount() {
  const active = loadServerConfig();
  if (active) await putActiveAccountAside(active);
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // no-op
  }
}

// What an account still has to send: { changes (collections), photos }.
async function countAccountUnsent(scope) {
  const active = loadServerConfig();
  if (active && accountScope(active) === scope) {
    let photos = 0;
    try {
      photos = JSON.parse(localStorage.getItem('certqr:photoUploads') || '[]').length;
    } catch {
      photos = 0;
    }
    return { changes: await countUnsentServerChanges(), photos };
  }
  const bundle = await readParkedAccount(scope);
  if (!bundle) return { changes: 0, photos: 0 };
  const keys = new Set();
  Object.entries(bundle.partial || {}).forEach(([key, record]) => {
    if (record && Array.isArray(record.ops) && record.ops.length) keys.add(key);
  });
  Object.entries(bundle.server || {}).forEach(([key, record]) => {
    if (record && record.dirty) keys.add(key);
  });
  let photos = 0;
  try {
    photos = JSON.parse((bundle.storage && bundle.storage['certqr:photoUploads']) || '[]').length;
  } catch {
    photos = 0;
  }
  return { changes: keys.size, photos };
}

// Forgets an account on this phone, with its data here (what's on the
// server stays). The one signed in is signed out first.
async function removeSavedAccount(scope) {
  const active = loadServerConfig();
  if (active && accountScope(active) === scope) await signOutAccount();
  const saved = loadSavedAccounts().find((a) => a.scope === scope);
  if (saved && saved.config) forgetServerSession(saved.config);
  await idbDelete(ACCOUNT_DATA_PREFIX + scope).catch(() => {});
  saveSavedAccounts(loadSavedAccounts().filter((a) => a.scope !== scope));
}

// Disconnects this device. What it last had of each collection is kept
// in its own storage, so the app still holds it afterwards.
async function disconnectServer() {
  const config = loadServerConfig();
  if (!config) return;
  // Sign this device out on the server too, so what it held stops working.
  if (serverReachable(config)) {
    try {
      await serverRequest(config, 'POST', 'logout', undefined, SERVER_READ_TIMEOUT_MS);
    } catch {
      // Unreachable: the server forgets it when the password next changes.
    }
  }
  for (const key of Object.keys(SERVER_COLLECTIONS)) {
    if (isPartialKey(key)) {
      await withServerKeyLock(key, async () => {
        const state = partialStates.get(key);
        const partial = state ? state.record : await readPartialRecord(key, config);
        if (partial) await persistLocalValue(key, withoutHidden(key, partial, partial.own));
        partialStates.delete(key);
        partialRecordsInMemory.delete(key);
        try {
          await idbDelete(PARTIAL_PREFIX + key);
        } catch {
          // no-op
        }
      });
    }
    await withServerKeyLock(key, async () => {
      const record = await readServerRecord(key, config);
      if (record && record.value !== undefined && !isPartialKey(key)) await persistLocalValue(key, record.value);
      serverRecordsInMemory.delete(key);
      try {
        await idbDelete(SERVER_RECORD_PREFIX + key);
      } catch {
        // no-op
      }
    });
  }
  serverDirtyKeys.clear();
  localStorage.removeItem(SERVER_CONFIG_KEY);
  setServerStatus({ state: 'off', message: '', lastSyncAt: null });
}

// Signed in before there was an account list: it starts with this one.
if (loadServerConfig() && !loadSavedAccounts().some((a) => a.scope === accountScope(loadServerConfig()))) {
  updateSavedAccount(loadServerConfig(), { remember: loadServerConfig().remember !== false });
}

// login-gate.js is sending this page to the login page: nothing of it
// is loaded or sent meanwhile.
const pageLocked = typeof window !== 'undefined' && window.CERTQR_LOCKED === true;

if (loadServerConfig() && !pageLocked) {
  window.addEventListener('online', () => flushServerQueue());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flushServerQueue();
  });
  // Whatever an earlier page left waiting, including collections this
  // page doesn't load.
  setTimeout(() => flushServerQueue(), 1500);
  // Names and admin, fetched again when they're more than a few minutes old.
  const account = loadServerConfig();
  const fetchedAt = Date.parse(account.accountAt || '') || 0;
  if (serverReachable(account) && Date.now() - fetchedAt > SERVER_ACCOUNT_REFRESH_MS) {
    setTimeout(() => refreshServerAccount().catch(() => {}), 800);
  }
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
  const serverConfig = serverConfigFor(key);
  if (serverConfig) {
    if (isPartialKey(key)) await hydratePartialKey(key, serverConfig);
    else await hydrateServerKey(key, serverConfig);
    return;
  }
  if (FORMER_SERVER_KEYS.includes(key)) {
    const taken = await takeBackFromServer(key);
    if (taken !== undefined) {
      storageCache.set(key, taken);
      return;
    }
  }
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

// A key that was kept with the server (FORMER_SERVER_KEYS): this
// phone's copy of it there, if it has one, is saved on the phone and
// the server copy let go of. Resolves to that value, or undefined when
// there was none.
async function takeBackFromServer(key) {
  let record;
  try {
    record = await idbGet(SERVER_RECORD_PREFIX + key);
  } catch {
    return undefined;
  }
  if (!record || record.value === undefined) return undefined;
  await persistLocalValue(key, record.value);
  try {
    await idbDelete(SERVER_RECORD_PREFIX + key);
  } catch {
    // Taken again next time; the same value, so no harm.
  }
  return record.value;
}

// Called once per page, before its first render, with the list of keys
// that page actually needs (e.g. [HISTORY_KEY] on the Scans page,
// [HISTORY_KEY, TABS_STATE_KEY] on the Worksheet page).
async function hydrateStorage(keys) {
  // On its way to the login page: the page never starts.
  if (pageLocked) return new Promise(() => {});
  await Promise.all(keys.map(hydrateKey));
}

function readStore(key, fallback) {
  const value = storageCache.get(key);
  return value == null ? fallback : value;
}

// Saves one value: to the shared server when this device is connected
// to one (see "Shared server"), otherwise to its file in the storage
// folder, or to IndexedDB if there's no folder or the write to it
// failed — so a save always lands somewhere a reload can find it.
// Never rejects.
async function persistValue(key, value) {
  const serverConfig = serverConfigFor(key);
  if (serverConfig) {
    try {
      if (isPartialKey(key)) await persistPartialValue(key, value, serverConfig);
      else await persistServerValue(key, value, serverConfig);
    } catch {
      // persistServerValue keeps the change itself; nothing more to do.
    }
    return;
  }
  await persistLocalValue(key, value);
}

async function persistLocalValue(key, value) {
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
  if (pageLocked) return;
  // Cert data, records, lab log: what changed becomes steps for the
  // server now, while the removal scope set for it still applies.
  if (isPartialKey(key) && serverConfigFor(key)) notePartialWrite(key, value);
  storageCache.set(key, value);
  pendingWrites.set(key, value);
  if (!activeWriters.has(key)) drainWrites(key);
}

// Sets `key` to `value` and resolves once that has actually been
// written — for a restore (backup.js), which is followed by a page
// reload that a write still on its way wouldn't survive. Connected to a
// shared server, the backup is put together with what's there instead
// (restoreServerValue).
async function replaceStoredValue(key, value) {
  pendingWrites.delete(key);
  const serverConfig = serverConfigFor(key);
  if (serverConfig) {
    storageCache.set(key, await restoreServerValue(key, value, serverConfig));
    return;
  }
  storageCache.set(key, value);
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

// --- Changing someone else's record ---
// A record is someone else's when another person saved it: by their
// user id (savedBy, kept on records from version 1.2.17), or, for older
// records, the technician named on it. Before editing it, moving it to
// another folder or deleting it for everyone, the person signed in
// gives their own password, so it's done on purpose, by them. It's then
// logged twice: in the server's audit log (Server Dashboard → Others'
// records), and in the record itself (record.edits), which the Records
// page shows. With no connection, the password is checked against this
// phone's offline sign-in, and the log entry is sent once it's back
// online. Not signed in to a shared server, nothing is anyone else's.
//   record.savedBy — { id, name }: who first saved it
//   record.edits   — [{ by, name, at, action, offline? }]: changes by others
const PENDING_CONFIRM_LOG_KEY = 'certqr:pendingConfirmLog';
const PENDING_EDIT_CONFIRM_KEY = 'certqr:pendingEditConfirm';
const OTHERS_ACTIONS = {
  edit: { title: 'Edit', verb: 'edit' },
  move: { title: 'Move', verb: 'move it to another folder' },
  delete: { title: 'Delete', verb: 'delete it for everyone' },
};

// Who the record belongs to, as a name.
function recordOwnerName(record) {
  return String((record && ((record.savedBy && record.savedBy.name) || record.technician)) || '').trim();
}

function isOthersRecord(record) {
  const config = loadServerConfig();
  if (!config || !record) return false;
  if (record.savedBy && record.savedBy.id) return record.savedBy.id !== config.userId;
  const owner = recordOwnerName(record).toLowerCase();
  const me = String(config.userName || config.userId || '').trim().toLowerCase();
  return Boolean(owner) && owner !== me;
}

// Who saves a record now (for record.savedBy), or null when not signed in.
function currentSaver() {
  const config = loadServerConfig();
  return config ? { id: config.userId || null, name: String(config.userName || config.userId || '') } : null;
}

function pendingConfirmLog() {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING_CONFIRM_LOG_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function setPendingConfirmLog(list) {
  try {
    if (list.length) localStorage.setItem(PENDING_CONFIRM_LOG_KEY, JSON.stringify(list));
    else localStorage.removeItem(PENDING_CONFIRM_LOG_KEY);
  } catch {
    // Storage full: the record's own log still has it.
  }
}

// Sends what was confirmed with no connection, once there is one.
async function flushConfirmLog() {
  const config = loadServerConfig();
  if (!config || !serverReachable(config)) return;
  for (const entry of pendingConfirmLog()) {
    try {
      const { status } = await serverRequest(config, 'POST', 'me/confirm', entry, SERVER_WRITE_TIMEOUT_MS);
      if (status !== 200 && status !== 400) return;
    } catch {
      return;
    }
    setPendingConfirmLog(pendingConfirmLog().filter((e) => !(e.at === entry.at && e.recordId === entry.recordId)));
  }
}

if (loadServerConfig()) {
  window.addEventListener('online', () => flushConfirmLog());
  setTimeout(() => flushConfirmLog().catch(() => {}), 3000);
}

// Checks the password of the person signed in: by the server (which
// logs it), or with no connection, against this phone's offline sign-in.
async function checkOwnPassword(password, details) {
  const config = loadServerConfig();
  if (!config) return { ok: false, error: 'Not signed in.' };
  if (serverReachable(config)) {
    try {
      const { status, data } = await serverRequest(config, 'POST', 'me/confirm', { ...details, password }, SERVER_WRITE_TIMEOUT_MS);
      if (status === 200) return { ok: true, offline: false };
      if (status === 401) {
        noteServerFailure(null, serverFailure(401, data));
        return { ok: false, error: 'Signed out. Sign in again first.' };
      }
      return { ok: false, error: (data && data.error) || `The server answered ${status}.` };
    } catch {
      // No connection after all: checked on this phone instead.
    }
  }
  const account = loadSavedAccounts().find((a) => a.scope === accountScope(config));
  if (!account || !account.verifier) return { ok: false, error: 'There\'s no connection, and this phone can\'t check your password offline yet. Try again once connected.' };
  if (!(await checkPasswordVerifier(account.verifier, password))) return { ok: false, error: 'That password isn\'t right.' };
  setPendingConfirmLog([...pendingConfirmLog(), { ...details, offline: true, at: new Date().toISOString() }]);
  return { ok: true, offline: true };
}

// Asks for the password before `action` ('edit', 'move', 'delete') on
// someone else's record. Resolves to the edit entry for record.edits
// ({ by, name, at, action, offline? }), or null if cancelled.
function confirmOthersRecord(record, action) {
  const config = loadServerConfig();
  const words = OTHERS_ACTIONS[action] || OTHERS_ACTIONS.edit;
  const owner = recordOwnerName(record) || 'someone else';
  const label = formatUutLabel(record.uutModel, record.uutSerial) || 'this record';
  return new Promise((resolve) => {
    const dialog = document.createElement('div');
    dialog.className = 'delete-scope confirm-others';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const box = document.createElement('form');
    box.className = 'delete-scope-box';
    box.autocomplete = 'off';
    const heading = document.createElement('p');
    heading.className = 'delete-scope-title';
    heading.textContent = `${words.title} ${owner}'s record?`;
    const note = document.createElement('p');
    note.className = 'delete-scope-note';
    note.textContent = `“${label}” was saved by ${owner}. To ${words.verb}, enter your own password${config && config.userName ? ` (${config.userName})` : ''}. Your name and the time are kept with the record and in the server's log.`;
    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'confirm-others-password';
    input.autocomplete = 'current-password';
    input.setAttribute('aria-label', 'Your password');
    input.placeholder = 'Your password';
    const show = document.createElement('label');
    show.className = 'setting-check confirm-others-show';
    const showBox = document.createElement('input');
    showBox.type = 'checkbox';
    showBox.addEventListener('change', () => { input.type = showBox.checked ? 'text' : 'password'; });
    show.append(showBox, ' Show password');
    const error = document.createElement('p');
    error.className = 'confirm-others-error';
    error.setAttribute('role', 'alert');
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.className = 'delete-scope-btn delete-scope-everyone';
    ok.textContent = `${words.title} it`;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'delete-scope-btn delete-scope-cancel';
    cancel.textContent = 'Cancel';
    box.append(heading, note, input, show, error, ok, cancel);
    dialog.appendChild(box);
    const finish = (value) => {
      dialog.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (event) => { if (event.key === 'Escape') finish(null); };
    document.addEventListener('keydown', onKey);
    cancel.addEventListener('click', () => finish(null));
    box.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!input.value) {
        error.textContent = 'Enter your password.';
        return;
      }
      ok.disabled = true;
      error.textContent = '';
      const result = await checkOwnPassword(input.value, { action, recordId: record.id || '', label, owner });
      ok.disabled = false;
      if (!result.ok) {
        error.textContent = result.error;
        input.select();
        return;
      }
      const saver = currentSaver();
      finish({ by: saver ? saver.id : null, name: saver ? saver.name : '', at: new Date().toISOString(), action, ...(result.offline ? { offline: true } : {}) });
    });
    document.body.appendChild(dialog);
    input.focus();
  });
}

// The Records page's Edit, confirmed: handed to the Worksheet page with
// the record (see "Edit this record" handoff above).
function setPendingEditConfirmation(recordId, edit) {
  try {
    localStorage.setItem(PENDING_EDIT_CONFIRM_KEY, JSON.stringify({ recordId, edit }));
  } catch {
    // The Worksheet page asks again when it's saved.
  }
}

function takePendingEditConfirmation(recordId) {
  try {
    const pending = JSON.parse(localStorage.getItem(PENDING_EDIT_CONFIRM_KEY) || 'null');
    localStorage.removeItem(PENDING_EDIT_CONFIRM_KEY);
    return pending && pending.recordId === recordId && pending.edit ? pending.edit : null;
  } catch {
    return null;
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
// Signed in to a shared server, the technician is the name you're
// signed in under and there are no other people (serverSettingsPeople):
// what's kept here is used again once disconnected.
const SETTINGS_KEY = 'certqr:settings';
const DEFAULT_OUT_TOO_LONG_DAYS = 7;

function loadSettings() {
  const saved = readStore(SETTINGS_KEY, null) || {};
  const days = Number(saved.outTooLongDays);
  const fromServer = serverSettingsPeople();
  const ownPeople = Array.isArray(saved.people) ? saved.people.filter((name) => typeof name === 'string' && name.trim() !== '') : [];
  return {
    technician: fromServer && fromServer.technician ? fromServer.technician : typeof saved.technician === 'string' ? saved.technician : '',
    people: fromServer && fromServer.people ? fromServer.people : ownPeople,
    // This phone's own, whatever the server says: what saveSettings
    // keeps, so the server's names aren't written over them.
    ownTechnician: typeof saved.technician === 'string' ? saved.technician : '',
    ownPeople,
    outTooLongDays: Number.isFinite(days) && days > 0 ? days : DEFAULT_OUT_TOO_LONG_DAYS,
    // What the Worksheet page makes: an unofficial record, with its own
    // simple table of readings, or a worksheet made from one of the
    // worksheet templates (loadWorksheetTemplates), picked per worksheet.
    recordMode: saved.recordMode === 'worksheet' ? 'worksheet' : 'unofficial',
  };
}

// Takes what loadSettings gave, changed. Signed in to a shared server,
// the technician and people shown came from it, so this phone's own are
// kept as they were.
function saveSettings(settings) {
  const { ownTechnician, ownPeople, ...rest } = settings;
  const fromServer = serverSettingsPeople();
  if (fromServer && fromServer.technician && ownTechnician !== undefined) rest.technician = ownTechnician;
  if (fromServer && fromServer.people && ownPeople !== undefined) rest.people = ownPeople;
  writeStore(SETTINGS_KEY, rest);
}

// Adds a name to the people list if it isn't on it already (whatever
// the capitals). Returns whether it was added. Signed in to a shared
// server, the people are whoever can sign in, so nothing is added.
function rememberPerson(name) {
  const trimmed = String(name || '').trim();
  const fromServer = serverSettingsPeople();
  if (!trimmed || (fromServer && fromServer.people)) return false;
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
  sendRecordPhotos(record);
  return entries;
}

// A saved worksheet's photos go to the shared server with it (photos.js;
// only on pages that load it, which every page that saves records does).
function sendRecordPhotos(record) {
  if (typeof queueRecordPhotos === 'function') queueRecordPhotos(record);
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
  sendRecordPhotos(record);
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
// first. No page lists it any more (the Sync Log took its place); it is
// still kept, and goes into backups. Written by the pages
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

// --- Worksheet templates ---
// The kinds of worksheet the Worksheet page offers when Settings has it
// on "Worksheet": forms designed in Digital Worksheet Designer and
// imported from .calfrm files by an admin (Settings → Worksheet
// templates). Kept on the shared server, so every phone has the same
// ones, with a copy on each phone for working offline; only an admin
// can change the list (the server refuses anyone else).
// worksheet-templates.js builds a worksheet from one.
//   [{ id, name, form: { title, description, items, settings },
//      importedAt, importedBy, updatedAt }]
const WORKSHEET_TEMPLATES_KEY = 'certqr:worksheetTemplates';

function loadWorksheetTemplates() {
  const parsed = readStore(WORKSHEET_TEMPLATES_KEY, []);
  return Array.isArray(parsed)
    ? parsed.filter((t) => t && typeof t.id === 'string' && t.form && Array.isArray(t.form.items))
    : [];
}

function saveWorksheetTemplates(templates) {
  writeStore(WORKSHEET_TEMPLATES_KEY, templates);
}

function findWorksheetTemplate(id) {
  return id ? loadWorksheetTemplates().find((t) => t.id === id) || null : null;
}

// Whether this device can change the templates: signed in to a shared
// server as an admin.
function canManageWorksheetTemplates() {
  const config = loadServerConfig();
  return Boolean(config && config.admin && !config.signedOut);
}

// Opens a .calfrm file: the server decrypts and checks it (it holds the
// key) and sends back the form, with its pictures as data: URLs. Rejects
// with a message fit to show.
async function readCalfrmFile(file) {
  const config = loadServerConfig();
  if (!config) throw new Error('Connect to the shared server first (Settings).');
  if (config.signedOut) throw new Error('Signed out. Sign in again first.');
  if (file.size > 20 * 1024 * 1024) throw new Error('That file is too big for a worksheet template (20 MB at most).');
  let res;
  try {
    res = await fetch(`${config.url}/api/v1/admin/templates/decode`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/octet-stream' },
      cache: 'no-store',
      body: await file.arrayBuffer(),
      signal: AbortSignal.timeout(SERVER_WRITE_TIMEOUT_MS),
    });
  } catch {
    throw new Error('Couldn\'t reach the server. Check the connection.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401) {
    noteServerFailure(null, serverFailure(401, data));
    throw new Error('Signed out. Sign in again.');
  }
  if (res.status !== 200 || !data || !data.form) throw new Error((data && data.error) || `The server answered ${res.status}.`);
  return data.form;
}

function makeTemplateId() {
  return `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Adds a template made from a .calfrm file, or — with `replaceId` —
// puts a new version of the file in place of that one, keeping its id
// (and its name, if it was renamed) so worksheets on it carry on.
async function importWorksheetTemplate(file, replaceId) {
  if (!canManageWorksheetTemplates()) throw new Error('Only an admin can add worksheet templates.');
  const form = await readCalfrmFile(file);
  const config = loadServerConfig();
  const now = new Date().toISOString();
  const templates = loadWorksheetTemplates();
  const by = String(config.userName || config.userId || '');
  const existing = replaceId ? templates.find((t) => t.id === replaceId) : null;
  const template = existing
    ? { ...existing, form, updatedAt: now, updatedBy: by }
    : { id: makeTemplateId(), name: String(form.title || '').trim() || file.name.replace(/\.calfrm$/i, ''), form, importedAt: now, importedBy: by, updatedAt: now };
  saveWorksheetTemplates(existing ? templates.map((t) => (t.id === replaceId ? template : t)) : [...templates, template]);
  return template;
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

// The photos of saved records only: what goes to the shared server.
function savedPhotoIds() {
  const ids = new Set();
  loadUutDatabase().forEach((record) => worksheetPhotoIds(record).forEach((id) => ids.add(id)));
  return ids;
}

function photoIdsInUse() {
  const ids = savedPhotoIds();
  const tabsState = readStore(TABS_STATE_KEY, null);
  const tabs = tabsState && Array.isArray(tabsState.tabs) ? tabsState.tabs : [];
  tabs.forEach((tab) => worksheetPhotoIds(tab).forEach((id) => ids.add(id)));
  return ids;
}
