// device-storage.js — when this app is running as the packaged Android
// app (via Capacitor), scan history, worksheet records and worksheet
// tab state are written as real files in an app-created folder on the
// phone: Documents/CertificateQR/*.json (app-specific external storage
// — no runtime permission prompt needed on Android 10+, and generally
// browsable from the Files app under Android/data). In plain-browser
// mode (npx serve / python -m http.server, no Capacitor bridge
// present) this module is inert and history.js falls back to its
// existing IndexedDB/localStorage behavior — see hydrateKey()/
// writeStore() there.
//
// Loaded before history.js on every page (same load-order requirement
// as theme.js) so history.js can feature-detect it.

const DEVICE_STORAGE_DIR = 'CertificateQR';

// @capacitor/filesystem's Directory/Encoding are TypeScript enums,
// exported from its JS module for bundled apps to `import` — not
// runtime values attached to window.Capacitor.Plugins.Filesystem. This
// app loads everything as plain <script> globals with no bundler (same
// as jsQR/pako), so there's nothing to import from; these are just
// those same enums' underlying string values, used directly.
const FS_DIRECTORY_DOCUMENTS = 'DOCUMENTS';
const FS_ENCODING_UTF8 = 'utf8';

function isNativeStorageAvailable() {
  return Boolean(
    window.Capacitor &&
    typeof window.Capacitor.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform() &&
    window.Capacitor.Plugins &&
    window.Capacitor.Plugins.Filesystem
  );
}

function deviceFileName(key) {
  // Storage keys are namespaced like "certqr:history" — colons are
  // fine on Android's filesystem, but sanitized anyway so the files
  // read cleanly if ever inspected on a desktop OS too.
  return `${key.replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
}

async function ensureDeviceStorageDir() {
  const { Filesystem } = window.Capacitor.Plugins;
  try {
    await Filesystem.mkdir({
      path: DEVICE_STORAGE_DIR,
      directory: FS_DIRECTORY_DOCUMENTS,
      recursive: true,
    });
  } catch {
    // Already exists — mkdir on an existing directory rejects, and
    // that's the common case after the first run.
  }
}

async function readDeviceFile(key) {
  const { Filesystem } = window.Capacitor.Plugins;
  try {
    const result = await Filesystem.readFile({
      path: `${DEVICE_STORAGE_DIR}/${deviceFileName(key)}`,
      directory: FS_DIRECTORY_DOCUMENTS,
      encoding: FS_ENCODING_UTF8,
    });
    return JSON.parse(result.data);
  } catch {
    // File doesn't exist yet (first run) or failed to parse — either
    // way, the caller treats undefined as "nothing saved yet".
    return undefined;
  }
}

async function writeDeviceFile(key, value) {
  await ensureDeviceStorageDir();
  const { Filesystem } = window.Capacitor.Plugins;
  await Filesystem.writeFile({
    path: `${DEVICE_STORAGE_DIR}/${deviceFileName(key)}`,
    directory: FS_DIRECTORY_DOCUMENTS,
    encoding: FS_ENCODING_UTF8,
    data: JSON.stringify(value),
  });
}
