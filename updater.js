// updater.js — keeps the Android app up to date by itself. Loaded on
// every page, after history.js, version.js and github-token.js; plain
// globals, no bundler — same pattern as the rest of this app.
//
// The app is a set of web files (everything in www/) inside a thin
// Android shell, and Capacitor can be told to serve those files from a
// folder on the phone instead of from inside the installed app. So an
// update doesn't need the app reinstalled: when a newer release is
// published on GitHub, the files of that release are downloaded into a
// folder of their own, and from the next time the app is opened it runs
// from there. Nothing here does anything in a browser — a copy of the
// app opened on a PC is updated by pulling the repo.
//
// What is downloaded is exactly www/ as it is at the release's tag,
// read through GitHub's API with the same read-only token the update
// check has always used (github-token.js; the repo is private). Every
// file is checked against the hash git recorded for it before it's
// kept, so what ends up running is byte for byte what was released.
//
// The steps, and what protects each:
//   1. Check — every time the app is opened, when it's come back to
//      after a while, and whenever Settings is opened: is the latest
//      release newer than APP_VERSION?
//   2. If it is, say so before anything else (see "Asking to update"):
//      a box over the page, asking for the update to be taken now.
//   3. Download its www/ into updates/<version>/ in the app's own data —
//      there and then if that's what was chosen, quietly in the
//      background if it was put off. A download cut short — the app
//      closed, another page opened — picks up where it left off.
//   4. Switch to it: straight away after "Update now" (or "Restart now"
//      in Settings), otherwise the next time the app is opened fresh —
//      never, uninvited, in the middle of someone's work.
//   5. The new files, once they have loaded and got this far, make the
//      switch permanent. If they never do — a release that doesn't
//      start — nothing was made permanent, the app opens from the
//      previous files next time, and that release isn't tried again
//      for a day.
// Two things an update like this can't deliver, and how each is caught:
//   - A release that needs the Android side changed (a new plugin, a
//     permission). Each release says which Android side it needs
//     (NATIVE_API in version.js); one that needs a newer one than is
//     installed is left alone, and Settings says a reinstall is needed.
//   - A freshly installed app. Installing or reinstalling the app always
//     starts from the files inside it (MainActivity.java sees to that);
//     the updater then carries on from there.

const GITHUB_REPO = 'JacksonCNN/certificate-qr-decoder';
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}`;
const RELEASES_API_URL = `${GITHUB_API_URL}/releases/latest`;

// Everything the updater remembers, in one localStorage entry:
//   nativeApi — the installed app's NATIVE_API (see above)
//   installed — { version, path } of the downloaded files in use, or null
//   staged    — { version, path } downloaded and waiting to be used
//   partial   — { version, done: { file: hash } } of a download under way
//   applying  — { version, at } set when switching to `staged`
//   failed    — { version, at, reason } of the last one that went wrong
//   needsInstall — a version that needs the app reinstalled
//   lastCheck — when GitHub was last asked
const UPDATE_STATE_KEY = 'certqr:update';
const UPDATE_SESSION_KEY = 'certqr:updateSession';
// The version whose update box was put off, for as long as the app stays open.
const UPDATE_PUT_OFF_KEY = 'certqr:updatePutOff';
const UPDATE_FOLDER = 'updates';
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const UPDATE_ASK_AGAIN_AFTER_MS = 30 * 60 * 1000;
const UPDATE_RETRY_FAILED_AFTER_MS = 24 * 60 * 60 * 1000;
const UPDATE_RETRY_ERROR_AFTER_MS = 10 * 60 * 1000;
const UPDATE_DOWNLOADS_AT_ONCE = 4;
// Where Capacitor serves the files inside the installed app from.
const BUILT_IN_SERVER_PATH = 'public';

// Release tags are conventionally "v1.2.0" — strip the leading "v" so
// compareVersions below is comparing numbers, not throwing "v1" away
// as NaN.
function normalizeVersion(tag) {
  return String(tag).replace(/^v/i, '');
}

// Numeric, dot-separated comparison (not string comparison) so e.g.
// "1.10.0" correctly compares as newer than "1.9.0".
function compareVersions(a, b) {
  const partsA = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const partsB = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (partsA[i] || 0) - (partsB[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function hasGithubToken() {
  return typeof GITHUB_TOKEN === 'string' && GITHUB_TOKEN !== '' && GITHUB_TOKEN !== 'PASTE_YOUR_TOKEN_HERE';
}

// One GitHub API request, as JSON. AbortSignal.timeout so a slow or
// unresponsive network (rather than an outright connection error) can't
// leave a check or a download hanging with no end.
async function githubJson(path, timeoutMs) {
  const res = await fetch(`${GITHUB_API_URL}${path}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// The latest release: { tag, version, name, url }.
async function fetchLatestRelease() {
  const data = await githubJson('/releases/latest', 10000);
  if (!data || !data.tag_name) throw new Error('Release response has no tag_name');
  return {
    tag: data.tag_name,
    version: normalizeVersion(data.tag_name),
    name: data.name || '',
    url: data.html_url || `https://github.com/${GITHUB_REPO}/releases/latest`,
  };
}

// --- State ---
function loadUpdateState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(UPDATE_STATE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveUpdateState(state) {
  try {
    localStorage.setItem(UPDATE_STATE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable — the updater just won't remember; nothing
    // else in the app depends on it.
  }
}

// Only the Android app can be updated this way — and only one whose
// WebView can do what the download needs.
function canSelfUpdate() {
  return Boolean(
    typeof isNativeApp === 'function' && isNativeApp() &&
    window.Capacitor.Plugins.WebView && window.Capacitor.Plugins.Filesystem &&
    window.crypto && window.crypto.subtle && typeof APP_VERSION === 'string' && hasGithubToken()
  );
}

// --- Downloading a release ---
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// The hash git itself gives a file's contents: SHA-1 over a short header
// ("blob <length>\0") followed by the bytes. Matching it is what says a
// downloaded file is the released one, whole.
async function gitBlobHash(bytes) {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const whole = new Uint8Array(header.length + bytes.length);
  whole.set(header, 0);
  whole.set(bytes, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', whole));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

// One file of the release, as base64 (what Filesystem.writeFile takes
// for a file that isn't text), checked against its hash.
async function downloadReleaseFile(entry) {
  const blob = await githubJson(`/git/blobs/${entry.sha}`, 60000);
  const base64 = String(blob.content || '').replace(/\s+/g, '');
  if ((await gitBlobHash(base64ToBytes(base64))) !== entry.sha) throw new Error(`${entry.path} did not download intact`);
  return base64;
}

async function removeUpdateFolder(version) {
  try {
    await window.Capacitor.Plugins.Filesystem.rmdir({ path: `${UPDATE_FOLDER}/${version}`, directory: 'DATA', recursive: true });
  } catch {
    // Wasn't there.
  }
}

// Downloads `release`'s www/ into its own folder and resolves to
// { version, path } — path being where on the phone it now is. Rejects
// with an Error whose `kind` is 'needs-install' for a release this
// install can't run, and plain otherwise. onProgress(done, total) is
// called as files arrive.
async function downloadRelease(release, onProgress) {
  const { Filesystem } = window.Capacitor.Plugins;
  const tree = await githubJson(`/git/trees/${encodeURIComponent(release.tag)}?recursive=1`, 20000);
  if (!tree || !Array.isArray(tree.tree) || tree.truncated) throw new Error('Could not list the release\'s files');
  const entries = tree.tree.filter((entry) => entry.type === 'blob' && entry.path.startsWith('www/'));
  const versionEntry = entries.find((entry) => entry.path === 'www/version.js');
  if (!versionEntry || !entries.some((entry) => entry.path === 'www/index.html')) throw new Error('The release has no app files in it');

  // The release's own version.js is read first: it says whether this
  // install can run it at all, and it has to agree with the tag — a
  // release whose files still say the old version would be downloaded
  // again on every check.
  const versionText = new TextDecoder().decode(base64ToBytes(await downloadReleaseFile(versionEntry)));
  const declared = /APP_VERSION\s*=\s*'([^']+)'/.exec(versionText);
  if (!declared || declared[1] !== release.version) {
    throw new Error(`Release ${release.tag} is marked as version ${declared ? declared[1] : '?'} in its version.js`);
  }
  const neededApi = Number((/NATIVE_API\s*=\s*(\d+)/.exec(versionText) || [])[1] || 1);
  if (neededApi > (loadUpdateState().nativeApi || 1)) {
    const error = new Error(`Version ${release.version} needs the app reinstalled`);
    error.kind = 'needs-install';
    throw error;
  }

  // Carry on with a download of this same version that was cut short;
  // anything else in the way is cleared out first.
  let state = loadUpdateState();
  if (!state.partial || state.partial.version !== release.version) {
    await removeUpdateFolder(release.version);
    state.partial = { version: release.version, done: {} };
    saveUpdateState(state);
  }
  const folder = `${UPDATE_FOLDER}/${release.version}`;
  const waiting = entries.filter((entry) => state.partial.done[entry.path] !== entry.sha);
  let finished = entries.length - waiting.length;
  if (onProgress) onProgress(finished, entries.length);

  async function worker() {
    for (;;) {
      const entry = waiting.shift();
      if (!entry) return;
      const base64 = await downloadReleaseFile(entry);
      await Filesystem.writeFile({
        path: `${folder}/${entry.path.slice('www/'.length)}`,
        // An empty file has no base64 to decode; written as empty text.
        ...(base64 ? { data: base64 } : { data: '', encoding: 'utf8' }),
        directory: 'DATA',
        recursive: true,
      });
      // Re-read each time: this is the only thing that changes it while
      // a download runs, but each worker saves its own progress.
      state = loadUpdateState();
      if (state.partial && state.partial.version === release.version) {
        state.partial.done[entry.path] = entry.sha;
        saveUpdateState(state);
      }
      finished += 1;
      if (onProgress) onProgress(finished, entries.length);
    }
  }
  await Promise.all(Array.from({ length: UPDATE_DOWNLOADS_AT_ONCE }, worker));

  const { uri } = await Filesystem.getUri({ path: folder, directory: 'DATA' });
  return { version: release.version, path: decodeURIComponent(new URL(uri).pathname) };
}

// --- Checking ---
// findUpdate() asks GitHub for the latest release and says where things
// stand, without downloading anything. Resolves to { status, release }
// where status is one of:
//   'current'       — already on the latest version
//   'available'     — a newer one exists, and this isn't the Android app
//                     (or it can't update itself)
//   'downloadable'  — a newer one exists and can be fetched
//   'staged'        — downloaded already, and used from the next time
//                     the app opens
//   'needs-install' — a newer one exists but needs the app reinstalled
//   'failed'        — a newer one exists but didn't start when it was
//                     tried; `error` says so. Left alone for a day.
// checkForUpdate(onProgress) goes on to fetch a 'downloadable' one, and
// so never resolves to that: it ends as 'staged', 'needs-install', or
// 'failed' with `error` saying why the download stopped.
// Both reject only if GitHub couldn't be asked at all. One
// checkForUpdate runs at a time: a second call while one is under way
// gets that one's answer.
let updateCheckRunning = null;

function checkForUpdate(onProgress) {
  if (!updateCheckRunning) {
    updateCheckRunning = runUpdateCheck(onProgress).finally(() => {
      updateCheckRunning = null;
    });
  }
  return updateCheckRunning;
}

// Notes that a check has run its course, which is what the wait before
// the next automatic one is counted from. Only a check that reached an
// answer gets here — one cut off part-way (the page left while a
// download was under way) leaves no mark, and so is taken up again by
// the very next page. `soon` is for an answer worth asking for again
// before long: a download that went wrong.
function markUpdateChecked(soon) {
  const state = loadUpdateState();
  state.lastCheck = Date.now() - (soon ? UPDATE_CHECK_EVERY_MS - UPDATE_RETRY_ERROR_AFTER_MS : 0);
  saveUpdateState(state);
}

async function findUpdate() {
  const release = await fetchLatestRelease();
  const state = loadUpdateState();
  let found;
  if (compareVersions(release.version, APP_VERSION) <= 0) {
    found = { status: 'current', release };
  } else if (!canSelfUpdate()) {
    found = { status: 'available', release };
  } else if (state.staged && state.staged.version === release.version) {
    found = { status: 'staged', release };
  } else if (state.failed && state.failed.version === release.version && Date.now() - state.failed.at < UPDATE_RETRY_FAILED_AFTER_MS) {
    found = { status: 'failed', release, error: state.failed.reason };
  } else if (state.needsInstall === release.version) {
    found = { status: 'needs-install', release };
  } else {
    // Not marked as checked: there's a download still to do.
    return { status: 'downloadable', release };
  }
  markUpdateChecked(false);
  return found;
}

async function runUpdateCheck(onProgress) {
  const found = await findUpdate();
  if (found.status !== 'downloadable') return found;
  const { release } = found;

  try {
    const staged = await downloadRelease(release, onProgress);
    const state = loadUpdateState();
    state.staged = staged;
    state.partial = null;
    state.needsInstall = null;
    saveUpdateState(state);
    markUpdateChecked(false);
    return { status: 'staged', release };
  } catch (err) {
    if (err && err.kind === 'needs-install') {
      const state = loadUpdateState();
      state.needsInstall = release.version;
      saveUpdateState(state);
      markUpdateChecked(false);
      return { status: 'needs-install', release };
    }
    // Not recorded as a failed version: a download that stopped (no
    // signal, a file that arrived damaged) is carried on with before
    // long, from where it got to.
    markUpdateChecked(true);
    return { status: 'failed', release, error: (err && err.message) || String(err) };
  }
}

// --- Switching to a staged update ---
// Points the app at the downloaded files; the page reloads into them.
// Resolves to false when there's nothing staged that's newer than what
// is running.
async function applyStagedUpdate() {
  const state = loadUpdateState();
  if (!canSelfUpdate() || !state.staged || compareVersions(state.staged.version, APP_VERSION) <= 0) return false;
  state.applying = { version: state.staged.version, at: Date.now() };
  saveUpdateState(state);
  await window.Capacitor.Plugins.WebView.setServerBasePath({ path: state.staged.path });
  return true;
}

// Removes every downloaded version except the ones still wanted.
async function clearOldUpdates(state) {
  const { Filesystem } = window.Capacitor.Plugins;
  const keep = new Set([state.installed, state.staged, state.partial].filter(Boolean).map((item) => item.version));
  try {
    const { files } = await Filesystem.readdir({ path: UPDATE_FOLDER, directory: 'DATA' });
    for (const file of files) {
      const name = typeof file === 'string' ? file : file.name;
      if (!keep.has(name)) await removeUpdateFolder(name);
    }
  } catch {
    // No updates folder — nothing has ever been downloaded.
  }
}

// --- Asking to update ---
// When the app is opened and a newer release is out, it says so before
// anything else: a box over the page asking for the update to be taken
// now. "Update now" downloads it there and then, with its progress
// showing, and restarts into it. It can be put off — someone in the
// middle of a job with a poor signal has to be able to get on — in
// which case it's downloaded quietly behind them and used the next time
// the app is opened, and the box isn't shown again until then.
// Nothing is asked when there's no connection: the app works without
// one, and so does this.
let updateDialog = null;

function closeUpdateDialog() {
  if (!updateDialog) return;
  updateDialog.remove();
  updateDialog = null;
}

// Shows (or redraws) the box. `progress` is { done, total } while a
// download runs; `buttons` are [{ label, primary, onClick }] — none
// while there's nothing to choose.
function renderUpdateDialog({ title, message, progress, buttons }) {
  if (!updateDialog) {
    updateDialog = document.createElement('div');
    updateDialog.className = 'update-dialog-overlay';
    updateDialog.setAttribute('role', 'dialog');
    updateDialog.setAttribute('aria-modal', 'true');
    updateDialog.setAttribute('aria-labelledby', 'update-dialog-title');
    document.body.appendChild(updateDialog);
  }
  updateDialog.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'update-dialog';

  const heading = document.createElement('h2');
  heading.id = 'update-dialog-title';
  heading.textContent = title;
  box.appendChild(heading);

  const text = document.createElement('p');
  text.setAttribute('role', 'status');
  text.textContent = message;
  box.appendChild(text);

  if (progress) {
    const bar = document.createElement('div');
    bar.className = 'update-dialog-progress';
    const fill = document.createElement('span');
    fill.style.width = `${progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%`;
    bar.appendChild(fill);
    box.appendChild(bar);
  }

  if (buttons.length > 0) {
    const actions = document.createElement('div');
    actions.className = 'update-dialog-actions';
    buttons.forEach((button) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = button.label;
      if (button.primary) btn.className = 'update-dialog-primary';
      btn.addEventListener('click', button.onClick);
      actions.appendChild(btn);
    });
    box.appendChild(actions);
  }

  updateDialog.appendChild(box);
  const first = box.querySelector('.update-dialog-primary') || box.querySelector('button');
  if (first) first.focus();
}

// Checks, and asks if there's something to ask about. Quiet when the
// app is up to date, when GitHub can't be reached, and when this
// version has already been put off since the app was opened.
async function promptForUpdate() {
  if (updateDialog || navigator.onLine === false) return;
  let found;
  try {
    if (updateCheckRunning) await updateCheckRunning.catch(() => {});
    found = await findUpdate();
  } catch {
    return;
  }
  const { status, release } = found;
  if (status === 'current' || status === 'available' || status === 'failed') return;

  let putOff = null;
  try {
    putOff = sessionStorage.getItem(UPDATE_PUT_OFF_KEY);
  } catch {
    putOff = null;
  }
  if (putOff === release.version) {
    // Still wanted, just not asked about again: fetched in the background.
    if (status === 'downloadable') checkForUpdate().catch(() => {});
    return;
  }
  const putItOff = () => {
    try {
      sessionStorage.setItem(UPDATE_PUT_OFF_KEY, release.version);
    } catch {
      // Without it the box may come back sooner; nothing else is lost.
    }
    closeUpdateDialog();
  };

  const needsInstall = () => renderUpdateDialog({
    title: 'Update needed',
    message: `Version ${release.version} of the app is out (this phone has v${APP_VERSION}), but it can't be downloaded into this install — the app itself has to be installed again. Ask for the new app file.`,
    buttons: [{ label: 'OK', primary: true, onClick: putItOff }],
  });

  const restart = async () => {
    renderUpdateDialog({ title: 'Updating…', message: 'Restarting into the new version…', buttons: [] });
    try {
      if (await applyStagedUpdate()) return;
    } catch {
      // Couldn't switch — carry on with what's running.
    }
    closeUpdateDialog();
  };

  const download = async () => {
    renderUpdateDialog({ title: 'Updating…', message: `Downloading version ${release.version}…`, progress: { done: 0, total: 0 }, buttons: [] });
    let result;
    try {
      result = await checkForUpdate((done, total) => {
        renderUpdateDialog({ title: 'Updating…', message: `Downloading version ${release.version}… ${done} of ${total} files`, progress: { done, total }, buttons: [] });
      });
    } catch (err) {
      result = { status: 'failed', error: (err && err.message) || String(err) };
    }
    if (result.status === 'staged') {
      await restart();
    } else if (result.status === 'needs-install') {
      needsInstall();
    } else if (result.status === 'current') {
      closeUpdateDialog();
    } else {
      renderUpdateDialog({
        title: 'Update not finished',
        message: `Version ${release.version} couldn't be downloaded (${result.error || 'no connection'}). Check the connection and try again — what has arrived so far is kept.`,
        buttons: [
          { label: 'Try again', primary: true, onClick: download },
          { label: 'Continue without updating', onClick: putItOff },
        ],
      });
    }
  };

  if (status === 'needs-install') {
    needsInstall();
  } else if (status === 'staged') {
    renderUpdateDialog({
      title: 'Update ready',
      message: `Version ${release.version} has been downloaded (this phone has v${APP_VERSION}). Restart the app now to use it.`,
      buttons: [
        { label: 'Restart now', primary: true, onClick: restart },
        { label: 'Later', onClick: putItOff },
      ],
    });
  } else {
    renderUpdateDialog({
      title: 'Update available',
      message: `Version ${release.version} of the app is out (this phone has v${APP_VERSION}). Please update before you carry on — it only takes a few seconds.`,
      buttons: [
        { label: 'Update now', primary: true, onClick: download },
        {
          label: 'Later',
          onClick: () => {
            putItOff();
            checkForUpdate().catch(() => {});
          },
        },
      ],
    });
  }
}

// --- Every time a page loads ---
async function startUpdater() {
  if (!canSelfUpdate()) return;
  const { WebView } = window.Capacitor.Plugins;
  const state = loadUpdateState();
  let servedFrom = BUILT_IN_SERVER_PATH;
  try {
    servedFrom = (await WebView.getServerBasePath()).path || BUILT_IN_SERVER_PATH;
  } catch {
    return;
  }

  if (servedFrom === BUILT_IN_SERVER_PATH) {
    // Running the files inside the installed app: this is what says
    // which Android side there is to work with.
    state.nativeApi = typeof NATIVE_API === 'number' ? NATIVE_API : 1;
    state.installed = null;
    // A switch was started and this is where the app ended up instead:
    // those files didn't start. Left alone for a day.
    if (state.applying) {
      state.failed = { version: state.applying.version, at: Date.now(), reason: 'The update did not start, so the app went back to the previous version.' };
      if (state.staged && state.staged.version === state.applying.version) state.staged = null;
      state.applying = null;
    }
  } else if (!state.installed || state.installed.path !== servedFrom) {
    // Running downloaded files for the first time, and they've got as
    // far as this: the switch is made permanent.
    try {
      await WebView.persistServerBasePath();
    } catch {
      return;
    }
    state.installed = { version: APP_VERSION, path: servedFrom };
    if (state.staged && state.staged.path === servedFrom) state.staged = null;
    state.applying = null;
  } else if (state.applying) {
    // Same story as above, from an earlier downloaded version.
    state.failed = { version: state.applying.version, at: Date.now(), reason: 'The update did not start, so the app went back to the previous version.' };
    if (state.staged && state.staged.version === state.applying.version) state.staged = null;
    state.applying = null;
  }
  // Something staged that isn't newer than what's running any more (the
  // app was reinstalled at that version, say) has nothing left to do.
  if (state.staged && compareVersions(state.staged.version, APP_VERSION) <= 0) state.staged = null;
  if (state.needsInstall && compareVersions(state.needsInstall, APP_VERSION) <= 0) state.needsInstall = null;
  saveUpdateState(state);

  // The app being opened fresh — the one moment a staged update can be
  // switched to without interrupting anything. sessionStorage lasts as
  // long as the app stays open, across its pages and the reload the
  // switch itself causes.
  let freshStart = false;
  try {
    freshStart = !sessionStorage.getItem(UPDATE_SESSION_KEY);
    sessionStorage.setItem(UPDATE_SESSION_KEY, '1');
  } catch {
    freshStart = false;
  }
  if (freshStart && state.staged) {
    try {
      if (await applyStagedUpdate()) return;
    } catch {
      // Couldn't switch — carry on with what's running.
    }
  }

  clearOldUpdates(state);

  // The Settings page checks for itself every time it's opened, and
  // says what it found in its own way.
  if (document.getElementById('check-update-btn')) return;

  if (freshStart) {
    // The app has just been opened: check now, and ask if there's a
    // newer version.
    promptForUpdate();
  } else if (navigator.onLine !== false && (state.partial || !state.lastCheck || Date.now() - state.lastCheck >= UPDATE_CHECK_EVERY_MS)) {
    // Moving between pages: nothing is asked, but a download that was
    // cut short is carried on with, and an app left open for hours
    // still finds out.
    checkForUpdate().catch(() => {
      // Offline, or GitHub unreachable — tried again at the next check.
    });
  }

  // Coming back to the app after it's been in the background counts as
  // opening it, once it's been a while since the last look.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const lastCheck = loadUpdateState().lastCheck || 0;
    if (Date.now() - lastCheck >= UPDATE_ASK_AGAIN_AFTER_MS) promptForUpdate();
  });
}

startUpdater();
