// backup.js — "Back up everything" and "Restore" on the Settings page.
// Loaded after history.js and photos.js; plain globals, no bundler —
// same pattern as the rest of this app.
//
// Everything the app keeps lives on the one phone, in files only this
// install of the app can read back. A backup puts all of it into one
// file that can be taken off the phone, and a restore reads such a file
// back in — after a new phone, a reinstall, or a mistake.
//
// What a backup is: a complete copy, as of the moment it's made. Not
// "what changed since the last one" — each file stands by itself, and
// any one of them is all that's needed to restore. Yesterday's data is
// therefore in yesterday's file and in today's, on purpose; only the
// newest has to be kept, and on the phone only the newest few are (see
// LOCAL_BACKUPS_KEPT).
// What a restore is: a replacement. The app ends up holding exactly what
// the file holds — nothing is merged in beside what's there — so a
// restore can't double anything up, however often it's done.
//
// The file is a .zip, so it opens on a PC like any other:
//   backup.json            what it is, when it was made, how much is in it
//   data/<collection>.json one per collection below
//   photos/<id>.jpg        every reading photo a worksheet or record uses
// Written "stored" (uncompressed): photos are JPEGs already, and it
// keeps the writer to a page of code with no library. Reading also
// copes with a zip that's been re-saved compressed.

const BACKUP_FORMAT = 1;
const BACKUP_APP_NAME = 'Certificate QR';
// How many backup files are left in the phone's own backups folder.
const LOCAL_BACKUPS_KEPT = 3;
const LOCAL_BACKUP_FOLDER = 'CertificateQR/backups';

// What goes into a backup: every collection the app saves, by the key
// it's stored under (the names are their owners' — history.js,
// interpolate.js, converter.js — spelled out here because this page
// doesn't load all of those files). `label` is how the count of it is
// worded; null for one that isn't a list of things.
const BACKUP_COLLECTIONS = [
  { key: 'certqr:history', file: 'history', label: 'scan' },
  { key: 'certqr:uutDatabase', file: 'uutDatabase', label: 'saved record' },
  { key: 'certqr:interpTabs', file: 'interpTabs', label: null },
  { key: 'certqr:customers', file: 'customers', label: 'customer folder' },
  { key: 'certqr:labLog', file: 'labLog', label: 'lab log entry' },
  { key: 'certqr:shareLog', file: 'shareLog', label: 'shared log entry' },
  { key: 'certqr:converter', file: 'converter', label: null },
  { key: 'certqr:settings', file: 'settings', label: null },
];

// --- The zip container ---
const ZIP_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function zipCrc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = ZIP_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// entries: [{ name, bytes }] → the zip file's bytes. Every entry is
// stored as it is.
function buildZip(entries) {
  const encoder = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [];
  const directory = [];
  let offset = 0;

  entries.forEach((entry) => {
    const name = encoder.encode(entry.name);
    const crc = zipCrc32(entry.bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // names are UTF-8
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, entry.bytes.length, true);
    local.setUint32(22, entry.bytes.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, entry.bytes);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, dosTime, true);
    central.setUint16(14, dosDate, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, entry.bytes.length, true);
    central.setUint32(24, entry.bytes.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    directory.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + entry.bytes.length;
  });

  const directorySize = directory.reduce((total, part) => total + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);

  const all = [...parts, ...directory, new Uint8Array(end.buffer)];
  const file = new Uint8Array(all.reduce((total, part) => total + part.length, 0));
  let at = 0;
  all.forEach((part) => {
    file.set(part, at);
    at += part.length;
  });
  return file;
}

// The zip file's bytes → Map of name → bytes. Throws if it isn't a zip
// this can read.
async function readZip(file) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  // The directory's whereabouts are in a record at the very end, behind
  // which there may be a comment.
  let end = -1;
  for (let i = file.length - 22; i >= Math.max(0, file.length - 22 - 65535); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('That file is not a zip.');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map();
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('That zip file is damaged.');
    const method = view.getUint16(at + 10, true);
    const packedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    // Some zip tools (Windows' own, re-saving a backup) write folder
    // separators as "\" — the same file either way.
    const name = decoder.decode(file.subarray(at + 46, at + 46 + nameLength)).replace(/\\/g, '/');
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue; // a folder, not a file

    const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    const packed = file.subarray(dataAt, dataAt + packedSize);
    if (method === 0) {
      entries.set(name, packed);
    } else if (method === 8 && typeof DecompressionStream === 'function') {
      const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      entries.set(name, new Uint8Array(await new Response(stream).arrayBuffer()));
    } else {
      throw new Error('That zip file is compressed in a way this app can\'t read.');
    }
  }
  return entries;
}

// --- Making a backup ---
function backupFileName(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `CertificateQR-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.zip`;
}

function countPlural(count, word) {
  if (count === 1) return `1 ${word}`;
  return `${count} ${word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`}`;
}

// What's in a backup, in words: "12 scans, 8 saved records, …, 15 photos".
function describeBackupCounts(counts) {
  const parts = BACKUP_COLLECTIONS.filter((c) => c.label && counts[c.file] > 0).map((c) => countPlural(counts[c.file], c.label));
  if (counts.photos > 0) parts.push(countPlural(counts.photos, 'photo'));
  return parts.length > 0 ? parts.join(', ') : 'nothing saved yet';
}

// Resolves to { fileName, bytes, counts, missingPhotos }.
async function buildBackup() {
  await hydrateStorage(BACKUP_COLLECTIONS.map((c) => c.key));
  const encoder = new TextEncoder();
  const entries = [];
  const counts = {};
  BACKUP_COLLECTIONS.forEach((collection) => {
    const value = readStore(collection.key, null);
    counts[collection.file] = Array.isArray(value) ? value.length : 0;
    entries.push({ name: `data/${collection.file}.json`, bytes: encoder.encode(JSON.stringify(value, null, 2)) });
  });

  // Every photo something still refers to. One that can't be found is
  // left out — and said so — rather than stopping the backup.
  let missingPhotos = 0;
  counts.photos = 0;
  for (const id of photoIdsInUse()) {
    const dataUrl = await loadPhoto(id);
    if (!dataUrl) {
      missingPhotos += 1;
      continue;
    }
    const binary = atob(dataUrlBase64(dataUrl));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    entries.push({ name: `photos/${id}.jpg`, bytes });
    counts.photos += 1;
  }

  const createdAt = new Date();
  entries.unshift({
    name: 'backup.json',
    bytes: encoder.encode(JSON.stringify({
      app: BACKUP_APP_NAME,
      format: BACKUP_FORMAT,
      createdAt: createdAt.toISOString(),
      appVersion: typeof APP_VERSION === 'string' ? APP_VERSION : '',
      counts,
    }, null, 2)),
  });
  return { fileName: backupFileName(createdAt), bytes: buildZip(entries), counts, missingPhotos };
}

// In the Android app a copy also stays on the phone, in
// Documents/CertificateQR/backups — where the Files app can see it, and
// where it outlives the app being removed. Only the newest few are kept
// there (each is a complete copy, so older ones only take up room).
// Resolves to where it was put, or '' if it couldn't be.
async function keepLocalBackup(fileName, bytes) {
  if (!isNativeApp()) return '';
  const { Filesystem } = window.Capacitor.Plugins;
  try {
    await Filesystem.writeFile({ path: `${LOCAL_BACKUP_FOLDER}/${fileName}`, data: bytesToBase64(bytes), directory: 'DOCUMENTS', recursive: true });
  } catch {
    return '';
  }
  try {
    const { files } = await Filesystem.readdir({ path: LOCAL_BACKUP_FOLDER, directory: 'DOCUMENTS' });
    // The date is in the name, so sorted by name is sorted by age.
    const names = files.map((file) => (typeof file === 'string' ? file : file.name)).filter((name) => /^CertificateQR-backup-.*\.zip$/.test(name)).sort();
    for (const name of names.slice(0, Math.max(0, names.length - LOCAL_BACKUPS_KEPT))) {
      await Filesystem.deleteFile({ path: `${LOCAL_BACKUP_FOLDER}/${name}`, directory: 'DOCUMENTS' });
    }
  } catch {
    // Couldn't tidy the older ones — the new one is saved all the same.
  }
  return `Documents/${LOCAL_BACKUP_FOLDER}/${fileName}`;
}

// Makes a backup and hands it over: to the share sheet (to send it
// somewhere off the phone) in the Android app, as a download in a
// browser. Resolves to { outcome, fileName, counts, missingPhotos,
// savedTo } — outcome being shareFile's.
async function backUpEverything() {
  const backup = await buildBackup();
  const savedTo = await keepLocalBackup(backup.fileName, backup.bytes);
  const result = await shareFile(
    'Certificate QR backup',
    `Certificate QR backup — ${formatSavedAt(new Date().toISOString())}\n${describeBackupCounts(backup.counts)}`,
    backup.fileName,
    'application/zip',
    backup.bytes,
  );
  // A backup that got as far as a file — on the phone, sent on, or
  // downloaded — is one that exists.
  if (savedTo || result.outcome === 'shared' || result.outcome === 'downloaded') {
    try {
      localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
    } catch {
      // Only the "last backed up" line goes without.
    }
  }
  return { outcome: result.outcome, fileName: backup.fileName, counts: backup.counts, missingPhotos: backup.missingPhotos, savedTo };
}


// --- Restoring ---
// Reads a backup file without changing anything. Resolves to { info,
// values, photos }: backup.json's contents, each collection's value by
// key, and the photos as Map of id → bytes. Throws, with a message fit
// to show, if the file isn't a backup this app made.
async function readBackup(fileBytes) {
  const entries = await readZip(fileBytes);
  const decoder = new TextDecoder();
  const readJson = (name) => {
    const bytes = entries.get(name);
    if (!bytes) return undefined;
    return JSON.parse(decoder.decode(bytes));
  };
  let info;
  try {
    info = readJson('backup.json');
  } catch {
    info = null;
  }
  if (!info || info.app !== BACKUP_APP_NAME) throw new Error('That file is not a Certificate QR backup.');
  if (!(info.format <= BACKUP_FORMAT)) throw new Error('That backup was made by a newer version of the app. Update the app, then restore it.');

  const values = {};
  const counts = {};
  BACKUP_COLLECTIONS.forEach((collection) => {
    let value;
    try {
      value = readJson(`data/${collection.file}.json`);
    } catch {
      throw new Error(`The backup's ${collection.file} data can't be read — the file is damaged.`);
    }
    // A collection the backup doesn't have (it's from before that
    // collection existed) is restored as empty, like everything else
    // that isn't in the file. But one the backup says it has, and that
    // isn't there, is a damaged file — not something to restore as
    // "nothing" over what the app holds now.
    if (value === undefined && info.counts && info.counts[collection.file] > 0) {
      throw new Error(`The backup's ${collection.file} data is missing — the file is damaged.`);
    }
    values[collection.key] = value === undefined ? null : value;
    counts[collection.file] = Array.isArray(value) ? value.length : 0;
  });
  const photos = new Map();
  entries.forEach((bytes, name) => {
    const match = /^photos\/([a-z0-9]+)\.jpg$/.exec(name);
    if (match) photos.set(match[1], bytes);
  });
  counts.photos = photos.size;
  return { info, values, counts, photos };
}

// Makes the app hold what the backup holds, and nothing else. Resolves
// once it's all written; the page should be reloaded after.
async function applyBackup(backup) {
  // The photos in use before, to clear away any the backup doesn't have.
  await hydrateStorage(BACKUP_COLLECTIONS.map((c) => c.key));
  const before = photoIdsInUse();

  for (const [id, bytes] of backup.photos) {
    await savePhoto(id, `data:image/jpeg;base64,${bytesToBase64(bytes)}`);
  }
  for (const collection of BACKUP_COLLECTIONS) {
    await replaceStoredValue(collection.key, backup.values[collection.key]);
  }
  const after = photoIdsInUse();
  await Promise.all([...before].filter((id) => !after.has(id)).map((id) => deletePhoto(id)));
}
