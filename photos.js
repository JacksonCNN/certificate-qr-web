// photos.js — photos of readings. Taken from a worksheet row on
// interpolate.html, shown again with the saved record on database.html.
// Loaded after history.js on both; plain globals, no bundler — same
// pattern as the rest of this app.
//
// A photo is stored once, under an id, and rows refer to it by that id
// (see history.js's "Reading photos, in use"). Where it's stored depends
// on how the app is running:
//   - the Android app: a real picture file in Documents/CertificateQR/
//     photos, next to the app's other files — so it's there in the
//     phone's Files app and gallery too. The file is named after the
//     reading it's a photo of, with the id on the end:
//       Fluke-754-SN-123_T1-Before_R02_Lab55_UUT59.00_<id>.jpg
//     The id is what finds it again; everything in front is for whoever
//     is looking through the folder, and is rewritten as the reading
//     changes (renamePhoto).
//   - anywhere else (and the Android app, if that file can't be
//     written): through history.js's stores like any other value — a
//     photo-<id>.json in the storage folder holding the picture as a
//     data: URL, or the same in IndexedDB. There's no file name to speak
//     of there.
// Signed in to a shared server, it's also sent there, and a photo this
// phone hasn't got is fetched from there ("On the shared server").

const NATIVE_PHOTO_FOLDER = 'CertificateQR/photos';
// Longest side, in pixels, a photo is kept at. A phone camera's full
// frame is several megabytes; a reading on a display is perfectly
// legible at a fraction of that.
const PHOTO_MAX_SIDE = 1600;
const PHOTO_JPEG_QUALITY = 0.85;

function photoStoreKey(id) {
  return `certqr:photo-${id}`;
}

function makePhotoId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function dataUrlBase64(dataUrl) {
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

// --- Naming a photo after its reading ---
// readingPhotoName() is the name without the extension: whose UUT, which
// table (and whether that was before or after adjustment), which row,
// and the two readings on it —
//   Fluke-754-SN-123_T1-Before_R02_Lab55_UUT59.00
// with _p2, _p3… on a row that has more than one photo. Parts that
// aren't known yet (a reading not typed in, an unnamed UUT) are left
// out or stood in for, so there's always a usable name.
function photoNamePart(text, maxLength) {
  return String(text || '')
    .trim()
    .replace(/[\s,/:]+/g, '-')
    .replace(/[^A-Za-z0-9.-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
}

// A reading keeps its minus sign, so "-" can't also be what sits
// between several readings in one cell: "10.1, -10.3 / 10.2" becomes
// "10.1+-10.3+10.2".
function photoReadingPart(text, maxLength) {
  return String(text || '')
    .trim()
    .replace(/[\s,/:]+/g, '+')
    .replace(/[^A-Za-z0-9.+-]/g, '')
    .replace(/^\++|\++$/g, '')
    .slice(0, maxLength);
}

function readingPhotoName({ label, tableNumber, stage, rowNumber, labRdg, uutRdg, photoNumber, photoCount }) {
  const stageWord = stage === 'before' ? '-Before' : stage === 'after' ? '-After' : '';
  const parts = [
    photoNamePart(label, 40) || 'UUT',
    `T${tableNumber}${stageWord}`,
    `R${String(rowNumber).padStart(2, '0')}`,
  ];
  const lab = photoReadingPart(labRdg, 24);
  const uut = photoReadingPart(uutRdg, 32);
  if (lab) parts.push(`Lab${lab}`);
  if (uut) parts.push(`UUT${uut}`);
  if (photoCount > 1) parts.push(`p${photoNumber}`);
  return parts.join('_');
}

// Every photo of a worksheet, or of a record saved from one, with the
// name its reading gives it: [{ id, name }]. `holder` is anything
// history.js's worksheetTables() reads; `label` is its UUT's label.
// Rows are numbered as that worksheet or record numbers them.
function worksheetPhotoNames(holder, label) {
  const named = [];
  worksheetTables(holder).forEach((table, tableIndex) => {
    (Array.isArray(table.rows) ? table.rows : []).forEach((row, rowIndex) => {
      const ids = rowPhotoIds([row]);
      ids.forEach((id, photoIndex) => {
        named.push({
          id,
          name: readingPhotoName({
            label,
            tableNumber: tableIndex + 1,
            stage: table.stage,
            rowNumber: rowIndex + 1,
            labRdg: row.labRdg,
            uutRdg: row.uutRdg,
            photoNumber: photoIndex + 1,
            photoCount: ids.length,
          }),
        });
      });
    });
  });
  return named;
}

// --- The Android app's photo folder ---
// Which file is which photo: id → file name, read off the folder once
// (the id is whatever follows the last "_", or the whole name for a
// photo saved before photos were named) and kept up to date from then
// on by everything below that adds, renames or removes a file.
let nativePhotoFiles = null;

function nativePhotoIndex() {
  if (!nativePhotoFiles) {
    nativePhotoFiles = (async () => {
      const index = new Map();
      try {
        const { files } = await window.Capacitor.Plugins.Filesystem.readdir({ path: NATIVE_PHOTO_FOLDER, directory: 'DOCUMENTS' });
        files.forEach((file) => {
          const name = typeof file === 'string' ? file : file.name;
          const match = /(?:^|_)([a-z0-9]+)\.jpg$/.exec(name || '');
          if (match) index.set(match[1], name);
        });
      } catch {
        // No folder yet — nothing has been saved to it.
      }
      return index;
    })();
  }
  return nativePhotoFiles;
}

function nativePhotoFileName(id, name) {
  return name ? `${name}_${id}.jpg` : `${id}.jpg`;
}

// A new photo goes in under its bare id; the worksheet it was taken on
// names it a moment later, along with any other photo whose reading has
// changed (interpolate.js's syncPhotoNames). Signed in to a shared
// server, it's sent there too (see "On the shared server" below).
// Kept on this phone. It goes to the shared server once the worksheet
// it's in is saved (queueRecordPhotos).
async function savePhoto(id, dataUrl) {
  await savePhotoLocally(id, dataUrl);
}

async function savePhotoLocally(id, dataUrl) {
  if (isNativeApp()) {
    try {
      const index = await nativePhotoIndex();
      const fileName = nativePhotoFileName(id, '');
      await window.Capacitor.Plugins.Filesystem.writeFile({
        path: `${NATIVE_PHOTO_FOLDER}/${fileName}`,
        data: dataUrlBase64(dataUrl),
        directory: 'DOCUMENTS',
        recursive: true,
      });
      index.set(id, fileName);
      return;
    } catch {
      // Documents not writable — keep it with the app's other data.
    }
  }
  await persistValue(photoStoreKey(id), dataUrl);
}

// Resolves to the photo as a data: URL, or null if it can't be found:
// from this phone, or else (signed in) from the shared server. A photo
// from the server — another phone's — goes into the photo cache below,
// not in with this phone's own photos, so viewing records doesn't fill
// the phone up.
async function loadPhoto(id) {
  const local = await loadLocalPhoto(id);
  if (local) return local;
  const cached = await photoCacheGet('full', id);
  if (cached) return cached;
  return fetchPhotoFromServer(id);
}

// --- Photos taken on this phone ---
// Kept for good (in Documents/CertificateQR/photos in the Android app):
// they're this phone's work, and may not be on the server yet. The list
// is what tells them apart from photos downloaded before downloads went
// to the cache (Settings → Storage → Clear downloaded photos).
const PHOTOS_TAKEN_HERE_KEY = 'certqr:photosTakenHere';

function photosTakenHere() {
  try {
    const list = JSON.parse(localStorage.getItem(PHOTOS_TAKEN_HERE_KEY) || '[]');
    return new Set(Array.isArray(list) ? list.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function markPhotoTakenHere(id) {
  const ids = photosTakenHere();
  ids.add(id);
  try {
    localStorage.setItem(PHOTOS_TAKEN_HERE_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage full: the photo is still kept while a worksheet or record uses it.
  }
}

// --- Other phones' photos: a cache, not kept for good ---
// Photos (and their small previews) downloaded from the shared server
// to show a record taken on another phone. Kept up to PHOTO_CACHE_MAX_BYTES
// in all; past that, the ones looked at longest ago go first. They're
// always on the server, so one that has gone is simply downloaded again
// next time (online). In the Android app they're files in the app's own
// cache folder, which the phone may also clear when it's short of space;
// elsewhere, IndexedDB.
//   index (localStorage, phone-wide): { "<kind>:<id>": { size, at } },
//   kind 'full' (the photo) or 'thumb' (its preview)
const PHOTO_CACHE_MAX_BYTES = 50 * 1024 * 1024;
const PHOTO_CACHE_INDEX_KEY = 'certqr:photoCache';
const PHOTO_CACHE_FOLDER = 'CertificateQR-photo-cache';

function photoCacheIndex() {
  try {
    const index = JSON.parse(localStorage.getItem(PHOTO_CACHE_INDEX_KEY) || '{}');
    return index && typeof index === 'object' ? index : {};
  } catch {
    return {};
  }
}

function setPhotoCacheIndex(index) {
  try {
    localStorage.setItem(PHOTO_CACHE_INDEX_KEY, JSON.stringify(index));
  } catch {
    // Not saved: the cache is tidied again next time something is added.
  }
}

const photoCacheEntry = (kind, id) => `${kind}:${id}`;
const photoCacheFile = (entry) => `${PHOTO_CACHE_FOLDER}/${entry.replace(':', '-')}.jpg`;
const photoCacheStoreKey = (entry) => `certqr:photocache-${entry}`;

async function photoCacheRead(entry) {
  if (isNativeApp()) {
    const { data } = await window.Capacitor.Plugins.Filesystem.readFile({ path: photoCacheFile(entry), directory: 'CACHE' });
    return `data:image/jpeg;base64,${data}`;
  }
  return (await idbGet(photoCacheStoreKey(entry))) || null;
}

async function photoCacheWrite(entry, dataUrl) {
  if (isNativeApp()) {
    await window.Capacitor.Plugins.Filesystem.writeFile({ path: photoCacheFile(entry), data: dataUrlBase64(dataUrl), directory: 'CACHE', recursive: true });
    return;
  }
  await idbSet(photoCacheStoreKey(entry), dataUrl);
}

async function photoCacheRemove(entry) {
  try {
    if (isNativeApp()) await window.Capacitor.Plugins.Filesystem.deleteFile({ path: photoCacheFile(entry), directory: 'CACHE' });
    else await idbDelete(photoCacheStoreKey(entry));
  } catch {
    // Already gone.
  }
}

async function photoCacheGet(kind, id) {
  const entry = photoCacheEntry(kind, id);
  const index = photoCacheIndex();
  if (!index[entry]) return null;
  try {
    const dataUrl = await photoCacheRead(entry);
    if (dataUrl) {
      index[entry].at = Date.now();
      setPhotoCacheIndex(index);
      return dataUrl;
    }
  } catch {
    // Cleared by the phone, or unreadable: forget it.
  }
  delete index[entry];
  setPhotoCacheIndex(index);
  return null;
}

// One write to the cache at a time, so two photos arriving together
// can't both decide there's room.
let photoCacheQueue = Promise.resolve();

function photoCachePut(kind, id, dataUrl) {
  photoCacheQueue = photoCacheQueue.then(async () => {
    const entry = photoCacheEntry(kind, id);
    const size = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
    if (size > PHOTO_CACHE_MAX_BYTES) return;
    await photoCacheWrite(entry, dataUrl);
    const index = photoCacheIndex();
    index[entry] = { size, at: Date.now() };
    // Oldest looked-at first, until it fits.
    let total = Object.values(index).reduce((sum, e) => sum + (Number(e.size) || 0), 0);
    const oldest = Object.keys(index).filter((k) => k !== entry).sort((a, b) => (index[a].at || 0) - (index[b].at || 0));
    for (const key of oldest) {
      if (total <= PHOTO_CACHE_MAX_BYTES) break;
      total -= Number(index[key].size) || 0;
      delete index[key];
      await photoCacheRemove(key);
    }
    setPhotoCacheIndex(index);
  }).catch(() => {});
  return photoCacheQueue;
}

async function photoCacheForget(id) {
  const index = photoCacheIndex();
  for (const kind of ['full', 'thumb']) {
    const entry = photoCacheEntry(kind, id);
    if (index[entry]) {
      delete index[entry];
      await photoCacheRemove(entry);
    }
  }
  setPhotoCacheIndex(index);
}

async function clearPhotoCache() {
  const index = photoCacheIndex();
  for (const entry of Object.keys(index)) await photoCacheRemove(entry);
  setPhotoCacheIndex({});
  if (isNativeApp()) {
    try {
      await window.Capacitor.Plugins.Filesystem.rmdir({ path: PHOTO_CACHE_FOLDER, directory: 'CACHE', recursive: true });
    } catch {
      // No folder: nothing was cached.
    }
  }
}

function photoCacheUsage() {
  const index = photoCacheIndex();
  const entries = Object.entries(index);
  return {
    photos: entries.filter(([k]) => k.startsWith('full:')).length,
    previews: entries.filter(([k]) => k.startsWith('thumb:')).length,
    bytes: entries.reduce((sum, [, e]) => sum + (Number(e.size) || 0), 0),
    max: PHOTO_CACHE_MAX_BYTES,
  };
}

// --- Previews ---
// A small copy of a photo (PHOTO_THUMB_SIDE on its longest side, a few
// tens of kB), sent to the server with the photo. A record from another
// phone shows the previews; the full photo is only downloaded when one
// is opened. A photo sent before there were previews gets one the first
// time a phone needs it: that phone downloads the photo, makes the
// preview and sends it, so it only happens once.
const PHOTO_THUMB_SIDE = 320;
const PHOTO_THUMB_QUALITY = 0.7;

function makePhotoThumb(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, PHOTO_THUMB_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', PHOTO_THUMB_QUALITY));
    };
    img.onerror = () => reject(new Error('Not a picture'));
    img.src = dataUrl;
  });
}

async function sendPhotoThumb(config, id, dataUrl) {
  try {
    const thumb = await makePhotoThumb(dataUrl);
    await photoServerFetch(config, 'PUT', `photos/${id}/thumb`, dataUrlBytes(thumb), { 'Content-Type': 'image/jpeg' });
    return thumb;
  } catch {
    return null;
  }
}

// The preview of a photo this phone hasn't got: from the cache, else the
// server, else made from the full photo (and sent, for everyone after).
async function loadPhotoThumb(id) {
  const cached = await photoCacheGet('thumb', id);
  if (cached) return cached;
  const config = loadServerConfig();
  if (!config || !serverReachable(config) || !PHOTO_ID_PATTERN.test(id)) return null;
  try {
    const res = await photoServerFetch(config, 'GET', `photos/${id}/thumb`);
    if (res.status === 200) {
      const thumb = await blobDataUrl(await res.blob());
      if (thumb.startsWith('data:image/')) {
        photoCachePut('thumb', id, thumb);
        return thumb;
      }
    }
    if (res.status === 401) {
      noteServerFailure(null, serverFailure(401, null));
      return null;
    }
  } catch {
    return null;
  }
  // No preview on the server yet.
  const full = await loadPhoto(id);
  if (!full) return null;
  const thumb = (config.readOnly ? null : await sendPhotoThumb(config, id, full)) || await makePhotoThumb(full).catch(() => null);
  if (thumb) photoCachePut('thumb', id, thumb);
  return thumb;
}

async function loadLocalPhoto(id) {
  if (isNativeApp()) {
    try {
      const fileName = (await nativePhotoIndex()).get(id);
      if (fileName) {
        const { data } = await window.Capacitor.Plugins.Filesystem.readFile({ path: `${NATIVE_PHOTO_FOLDER}/${fileName}`, directory: 'DOCUMENTS' });
        return `data:image/jpeg;base64,${data}`;
      }
    } catch {
      // Not readable — it may have been saved the other way; see savePhoto.
    }
  }
  const key = photoStoreKey(id);
  const folder = await openFolderStore();
  if (folder) {
    try {
      const value = await folder.get(key);
      if (value) return value;
    } catch {
      // Unreadable — fall through to the browser's copy, if any.
    }
  }
  try {
    return (await idbGet(key)) || null;
  } catch {
    return null;
  }
}

// --- On the shared server ---
// Signed in to a shared server, a worksheet's photos are sent there
// when it's saved as a record (queueRecordPhotos), so the record opened
// on another phone shows them too. Photos in a worksheet that's still
// open stay on this phone. One that can't be sent yet (offline, server
// down) waits in a list kept in localStorage and goes the next time the
// server can be reached. Photos of records saved before signing in are
// sent too: every page that shows photos asks the server which of the
// saved records' photos it lacks (syncPhotosWithServer). A photo deleted here stays on the server,
// where someone else's copy of a record may still show it.
const PHOTO_UPLOADS_KEY = 'certqr:photoUploads';
const PHOTO_CHECKED_KEY = 'certqr:photoCheckedAt';
const PHOTO_CHECK_EVERY_MS = 10 * 60 * 1000;
const PHOTO_SERVER_TIMEOUT_MS = 60000;
const PHOTO_ID_PATTERN = /^[a-z0-9]{4,40}$/;

function pendingPhotoUploads() {
  try {
    const list = JSON.parse(localStorage.getItem(PHOTO_UPLOADS_KEY) || '[]');
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string' && PHOTO_ID_PATTERN.test(id)) : [];
  } catch {
    return [];
  }
}

function setPendingPhotoUploads(ids) {
  try {
    if (ids.length > 0) localStorage.setItem(PHOTO_UPLOADS_KEY, JSON.stringify([...new Set(ids)]));
    else localStorage.removeItem(PHOTO_UPLOADS_KEY);
  } catch {
    // Storage full: the next check (syncPhotosWithServer) finds it again.
  }
}

// A record has just been saved: its photos are sent. Ones the server
// already has come back as already there, and cost a moment each.
function queueRecordPhotos(record) {
  if (!loadServerConfig()) return;
  const ids = worksheetPhotoIds(record).filter((id) => PHOTO_ID_PATTERN.test(id));
  if (ids.length === 0) return;
  setPendingPhotoUploads([...pendingPhotoUploads(), ...ids]);
  uploadPendingPhotos();
}

function photoServerFetch(config, method, path, body, headers) {
  return fetch(`${config.url}/api/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.token}`, ...(headers || {}) },
    cache: 'no-store',
    body,
    signal: AbortSignal.timeout(PHOTO_SERVER_TIMEOUT_MS),
  });
}

function dataUrlBytes(dataUrl) {
  const binary = atob(dataUrlBase64(dataUrl));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Sends what's waiting, one photo at a time, until the list is empty or
// the server can't be reached (then it's tried again later). One run at
// a time; asking while one is going waits for that one, which picks up
// anything added meanwhile.
let photoUploadRunning = null;

function uploadPendingPhotos() {
  if (!photoUploadRunning) {
    photoUploadRunning = sendPendingPhotos().finally(() => {
      photoUploadRunning = null;
    });
  }
  return photoUploadRunning;
}

async function sendPendingPhotos() {
  for (;;) {
    const config = loadServerConfig();
    if (!config || !serverReachable(config)) return;
    const [id] = pendingPhotoUploads();
    if (!id) return;
    const dataUrl = await loadLocalPhoto(id);
    if (dataUrl) {
      let res;
      try {
        res = await photoServerFetch(config, 'PUT', `photos/${id}`, dataUrlBytes(dataUrl), { 'Content-Type': 'image/jpeg' });
      } catch {
        return;
      }
      if (res.status === 401) {
        noteServerFailure(null, serverFailure(401, null));
        return;
      }
      // Too big or not a JPEG can never go; anything else (busy, share
      // down) is tried again later.
      if (res.status !== 200 && res.status !== 400 && res.status !== 413) return;
      if (res.status === 200) {
        // Its preview, for other phones to show (best effort: one that
        // doesn't arrive is made by the first phone that needs it).
        await sendPhotoThumb(config, id, dataUrl);
        if (typeof noteSyncSent === 'function') noteSyncSent('photos', { added: [], changed: [], removed: [], updated: false }, 1);
      }
    }
    setPendingPhotoUploads(pendingPhotoUploads().filter((waiting) => waiting !== id));
  }
}

async function fetchPhotoFromServer(id) {
  const config = loadServerConfig();
  if (!config || !serverReachable(config) || !PHOTO_ID_PATTERN.test(id)) return null;
  try {
    const res = await photoServerFetch(config, 'GET', `photos/${id}`);
    if (res.status === 401) {
      noteServerFailure(null, serverFailure(401, null));
      return null;
    }
    if (res.status !== 200) return null;
    const dataUrl = await blobDataUrl(await res.blob());
    if (!dataUrl.startsWith('data:image/')) return null;
    // Another phone's photo: into the cache, not kept for good.
    photoCachePut('full', id, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}

// Finds the photos in use here that the server hasn't got yet (taken
// before signing in, or while a send failed) and sends them. At most
// every few minutes unless `now`.
async function syncPhotosWithServer(now) {
  const config = loadServerConfig();
  if (!config || !serverReachable(config)) return;
  let checkedAt = 0;
  try {
    checkedAt = Number(localStorage.getItem(PHOTO_CHECKED_KEY)) || 0;
  } catch {
    // Check anyway.
  }
  if (!now && Date.now() - checkedAt < PHOTO_CHECK_EVERY_MS) {
    uploadPendingPhotos();
    return;
  }
  await hydrateStorage([UUT_DATABASE_KEY]);
  const ids = [...savedPhotoIds()].filter((id) => PHOTO_ID_PATTERN.test(id));
  const missing = [];
  for (let start = 0; start < ids.length; start += 1000) {
    let res;
    try {
      res = await photoServerFetch(config, 'POST', 'photos/missing', JSON.stringify({ ids: ids.slice(start, start + 1000) }), { 'Content-Type': 'application/json' });
    } catch {
      return;
    }
    if (res.status !== 200) return;
    const data = await res.json().catch(() => null);
    if (data && Array.isArray(data.missing)) missing.push(...data.missing);
  }
  try {
    localStorage.setItem(PHOTO_CHECKED_KEY, String(Date.now()));
  } catch {
    // Checked again next time.
  }
  // Only the ones this phone has can be sent; the rest are another
  // phone's to send.
  const mine = [];
  for (const id of missing) {
    if (await loadLocalPhoto(id)) mine.push(id);
  }
  if (mine.length > 0) setPendingPhotoUploads([...pendingPhotoUploads(), ...mine]);
  await uploadPendingPhotos();
}

if (loadServerConfig()) {
  window.addEventListener('online', () => uploadPendingPhotos());
  setTimeout(() => syncPhotosWithServer().catch(() => {}), 2500);
}

// One file operation on the photo folder at a time: a rename racing a
// second rename (or a delete) of the same photo would leave the index
// pointing at a name that's already gone.
let nativePhotoQueue = Promise.resolve();

function queueNativePhotoWork(work) {
  nativePhotoQueue = nativePhotoQueue.then(work).catch(() => {});
  return nativePhotoQueue;
}

// Gives the photo's file the name of the reading it now belongs to (see
// readingPhotoName). Only means something in the Android app, where the
// photo is a file someone can look at; a no-op everywhere else, and when
// the file already has that name.
function renamePhoto(id, name) {
  if (!isNativeApp()) return Promise.resolve();
  return queueNativePhotoWork(async () => {
    const index = await nativePhotoIndex();
    const current = index.get(id);
    const wanted = nativePhotoFileName(id, name);
    if (!current || current === wanted) return;
    await window.Capacitor.Plugins.Filesystem.rename({
      from: `${NATIVE_PHOTO_FOLDER}/${current}`,
      to: `${NATIVE_PHOTO_FOLDER}/${wanted}`,
      directory: 'DOCUMENTS',
      toDirectory: 'DOCUMENTS',
    });
    index.set(id, wanted);
  });
}

// Removes the photo from wherever it was saved. Each place is tried,
// and "wasn't there" is not an error.
async function deletePhoto(id) {
  const key = photoStoreKey(id);
  if (isNativeApp()) {
    await queueNativePhotoWork(async () => {
      const index = await nativePhotoIndex();
      const fileName = index.get(id);
      if (!fileName) return;
      index.delete(id);
      await window.Capacitor.Plugins.Filesystem.deleteFile({ path: `${NATIVE_PHOTO_FOLDER}/${fileName}`, directory: 'DOCUMENTS' });
    });
  }
  const folder = await openFolderStore();
  if (folder) {
    try {
      await folder.remove(key);
    } catch {
      // no-op
    }
  }
  try {
    await idbDelete(key);
  } catch {
    // no-op
  }
  await photoCacheForget(id);
}

// --- How much room photos take, and clearing downloaded ones ---
// (Settings → Storage.) This phone's own photos are those taken here,
// and any used by its open worksheets, by the records it saved, or still
// waiting to be sent. Every other photo kept here for good was
// downloaded to show another phone's record (before those went to the
// cache): those, and the cache, can be cleared. A photo is only deleted
// once the server says it has it, so nothing is ever lost.

// The photos kept here for good: [{ id, bytes }].
async function localPhotoList() {
  const list = [];
  if (isNativeApp()) {
    try {
      const { files } = await window.Capacitor.Plugins.Filesystem.readdir({ path: NATIVE_PHOTO_FOLDER, directory: 'DOCUMENTS' });
      files.forEach((file) => {
        const name = typeof file === 'string' ? file : file.name;
        const match = /(?:^|_)([a-z0-9]+)\.jpg$/.exec(name || '');
        if (match) list.push({ id: match[1], bytes: typeof file === 'object' && Number.isFinite(file.size) ? file.size : 0 });
      });
    } catch {
      // No folder yet.
    }
    return list;
  }
  // Elsewhere photos are values in the store: look for every photo a
  // worksheet or record here refers to.
  await hydrateStorage([UUT_DATABASE_KEY, TABS_STATE_KEY]);
  for (const id of photoIdsInUse()) {
    const dataUrl = await loadLocalPhoto(id);
    if (dataUrl) list.push({ id, bytes: Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75) });
  }
  return list;
}

// This phone's own photos (never cleared), or null when that can't be
// told (not signed in: everything here is this phone's).
async function ownPhotoIds() {
  const config = loadServerConfig();
  if (!config) return null;
  const own = photosTakenHere();
  pendingPhotoUploads().forEach((id) => own.add(id));
  await hydrateStorage([TABS_STATE_KEY]);
  const tabsState = readStore(TABS_STATE_KEY, null);
  (tabsState && Array.isArray(tabsState.tabs) ? tabsState.tabs : []).forEach((tab) => worksheetPhotoIds(tab).forEach((id) => own.add(id)));
  const records = await readPartialRecord(UUT_DATABASE_KEY, config);
  if (!records) return null;
  records.own.forEach((record) => worksheetPhotoIds(record).forEach((id) => own.add(id)));
  return own;
}

// { mine: { count, bytes }, downloaded: { count, bytes }, cache, canClear }
async function photoStorageSummary() {
  const list = await localPhotoList();
  const own = await ownPhotoIds();
  const sum = (items) => ({ count: items.length, bytes: items.reduce((total, p) => total + p.bytes, 0) });
  const mine = own ? list.filter((p) => own.has(p.id)) : list;
  const downloaded = own ? list.filter((p) => !own.has(p.id)) : [];
  const cache = photoCacheUsage();
  return { mine: sum(mine), downloaded: sum(downloaded), cache, canClear: Boolean(own) && (downloaded.length > 0 || cache.photos + cache.previews > 0) };
}

// Clears the cache, and deletes the downloaded photos kept for good that
// the server has. Resolves to { cleared, bytes, kept } (kept: ones the
// server hasn't got, left alone).
async function clearDownloadedPhotos() {
  const config = loadServerConfig();
  if (!config || !serverReachable(config)) throw new Error('Connect to the shared server first: a photo is only cleared once the server is known to have it.');
  const own = await ownPhotoIds();
  if (!own) throw new Error('Couldn\'t tell this phone\'s own photos apart just now. Open the Records page once, then try again.');
  const cacheBytes = photoCacheUsage().bytes;
  await clearPhotoCache();
  const downloaded = (await localPhotoList()).filter((p) => !own.has(p.id) && PHOTO_ID_PATTERN.test(p.id));
  const missing = new Set();
  for (let start = 0; start < downloaded.length; start += 1000) {
    const res = await photoServerFetch(config, 'POST', 'photos/missing', JSON.stringify({ ids: downloaded.slice(start, start + 1000).map((p) => p.id) }), { 'Content-Type': 'application/json' });
    if (res.status !== 200) throw new Error(`The server answered ${res.status}; nothing more was cleared.`);
    const data = await res.json().catch(() => null);
    (data && Array.isArray(data.missing) ? data.missing : []).forEach((id) => missing.add(id));
  }
  let cleared = 0;
  let bytes = cacheBytes;
  for (const photo of downloaded) {
    if (missing.has(photo.id)) continue;
    await deletePhoto(photo.id);
    cleared += 1;
    bytes += photo.bytes;
  }
  return { cleared, bytes, kept: missing.size };
}

// Deletes whichever of these photos nothing refers to any more — call
// it after the change that let go of them (a row, a worksheet or a
// record removed) has been written to the store.
function deleteUnusedPhotos(ids) {
  if (ids.length === 0) return;
  const inUse = photoIdsInUse();
  ids.filter((id) => !inUse.has(id)).forEach((id) => deletePhoto(id));
}

// --- Taking a photo ---
// A file input with `capture` is what opens the camera: straight to it
// in the Android app and in a phone's browser. A desktop browser has no
// such thing and shows its file picker instead, which does for adding a
// picture taken some other way.
let photoInput = null;
let photoWaiting = null;

function readPhotoFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(objectUrl);
      resolve(canvas.toDataURL('image/jpeg', PHOTO_JPEG_QUALITY));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read that file as a picture.'));
    };
    img.src = objectUrl;
  });
}

// Opens the camera; once a picture is taken it's shrunk, saved, and
// handed to onPhoto(id, dataUrl). Backing out of the camera calls
// nothing.
function capturePhoto(onPhoto) {
  if (!photoInput) {
    photoInput = document.createElement('input');
    photoInput.type = 'file';
    photoInput.accept = 'image/*';
    photoInput.setAttribute('capture', 'environment');
    photoInput.hidden = true;
    document.body.appendChild(photoInput);
    photoInput.addEventListener('change', async () => {
      const file = photoInput.files && photoInput.files[0];
      const waiting = photoWaiting;
      photoWaiting = null;
      photoInput.value = '';
      if (!file || !waiting) return;
      try {
        const dataUrl = await readPhotoFile(file);
        const id = makePhotoId();
        await savePhoto(id, dataUrl);
        markPhotoTakenHere(id);
        waiting(id, dataUrl);
      } catch (err) {
        window.alert(`Could not save the photo: ${(err && err.message) || err}`);
      }
    });
  }
  photoWaiting = onPhoto;
  photoInput.click();
}

// --- Showing photos ---
// A thumbnail is a button with the picture in it, filled in once the
// photo has loaded; pressing it opens the photo full size. `onDelete`,
// when given, puts a Delete button in that full-size view.
function buildPhotoThumb(id, onDelete, knownDataUrl) {
  const thumb = document.createElement('button');
  thumb.type = 'button';
  thumb.className = 'photo-thumb';
  thumb.title = 'View photo';
  thumb.setAttribute('aria-label', 'View photo');
  const img = document.createElement('img');
  img.alt = '';
  thumb.appendChild(img);

  // The full photo, once known: this phone's own straight away; another
  // phone's only when it's opened (the thumbnail shows its preview).
  let dataUrl = knownDataUrl || null;
  if (dataUrl) {
    img.src = dataUrl;
  } else {
    loadLocalPhoto(id).then(async (local) => {
      if (local) {
        dataUrl = local;
        img.src = local;
        return;
      }
      const preview = (await photoCacheGet('full', id)) || (await loadPhotoThumb(id));
      if (preview) img.src = preview;
      else thumb.classList.add('photo-thumb-missing');
    });
  }
  thumb.addEventListener('click', async () => {
    if (!dataUrl) {
      thumb.classList.add('photo-thumb-loading');
      dataUrl = await loadPhoto(id);
      thumb.classList.remove('photo-thumb-loading');
      if (!dataUrl) {
        window.alert('This photo can\'t be shown just now. It\'s on the shared server: try again with a connection.');
        return;
      }
    }
    openPhotoViewer(dataUrl, onDelete);
  });
  return thumb;
}

let photoViewer = null;

function closePhotoViewer() {
  if (!photoViewer) return;
  photoViewer.remove();
  photoViewer = null;
  document.removeEventListener('keydown', photoViewerKeydown);
}

function photoViewerKeydown(event) {
  if (event.key === 'Escape') closePhotoViewer();
}

function openPhotoViewer(dataUrl, onDelete) {
  closePhotoViewer();
  photoViewer = document.createElement('div');
  photoViewer.className = 'photo-viewer';
  photoViewer.setAttribute('role', 'dialog');
  photoViewer.setAttribute('aria-label', 'Photo');

  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = 'Photo of the reading';
  photoViewer.appendChild(img);

  const actions = document.createElement('div');
  actions.className = 'photo-viewer-actions';
  if (onDelete) {
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'photo-viewer-delete';
    deleteBtn.textContent = 'Delete photo';
    deleteBtn.addEventListener('click', () => {
      if (!window.confirm('Delete this photo?')) return;
      closePhotoViewer();
      onDelete();
    });
    actions.appendChild(deleteBtn);
  }
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', closePhotoViewer);
  actions.appendChild(closeBtn);
  photoViewer.appendChild(actions);

  // A press on the dark surround closes it too; one on the picture or
  // the buttons doesn't.
  photoViewer.addEventListener('click', (event) => {
    if (event.target === photoViewer) closePhotoViewer();
  });
  document.addEventListener('keydown', photoViewerKeydown);
  document.body.appendChild(photoViewer);
}
