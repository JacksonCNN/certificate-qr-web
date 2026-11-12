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
// changed (interpolate.js's syncPhotoNames).
async function savePhoto(id, dataUrl) {
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

// Resolves to the photo as a data: URL, or null if it can't be found.
async function loadPhoto(id) {
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

  let dataUrl = knownDataUrl || null;
  if (dataUrl) {
    img.src = dataUrl;
  } else {
    loadPhoto(id).then((loaded) => {
      dataUrl = loaded;
      if (loaded) img.src = loaded;
      else thumb.classList.add('photo-thumb-missing');
    });
  }
  thumb.addEventListener('click', () => {
    if (dataUrl) openPhotoViewer(dataUrl, onDelete);
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
