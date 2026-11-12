// settings.js — the Settings page. First on it, the look of the app:
// which theme, and light or dark. Applying the choice (reading
// localStorage, setting data-palette and data-theme before first
// paint) lives in theme.js since every page needs it — this file only
// offers the options and reflects whichever are currently active.

const paletteGrid = document.getElementById('palette-grid');

// One card per theme: a small sample of it over its name. The sample
// carries data-palette, which is all it takes for style.css to colour
// and shape it as that theme.
function syncPaletteCards() {
  const current = getPreferredPalette();
  paletteGrid.querySelectorAll('.palette-card').forEach((card) => {
    card.setAttribute('aria-pressed', String(card.dataset.paletteChoice === current));
  });
}

PALETTES.forEach((palette) => {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'palette-card';
  card.dataset.paletteChoice = palette.id;

  const sample = document.createElement('span');
  sample.className = 'palette-sample';
  sample.dataset.palette = palette.id;
  sample.setAttribute('aria-hidden', 'true');
  sample.innerHTML = '<span class="palette-sample-card"><span class="palette-sample-title">Aa</span><span class="palette-sample-text"></span><span class="palette-sample-button"></span></span>';
  card.appendChild(sample);
  card.appendChild(document.createElement('span')).textContent = palette.name;

  card.addEventListener('click', () => {
    setPalette(palette.id);
    syncPaletteCards();
  });
  paletteGrid.appendChild(card);
});

syncPaletteCards();

const themeTabs = document.querySelectorAll('#theme-tabs .input-tab');

function syncThemeTabs() {
  const current = getPreferredTheme();
  themeTabs.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeChoice === current);
  });
}

themeTabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    setTheme(btn.dataset.themeChoice);
    syncThemeTabs();
  });
});

syncThemeTabs();

// --- Technician and people ---
// history.js's settings: who uses this phone, who else takes equipment
// out, and how long out is too long. Each is saved as it's changed.
const technicianInput = document.getElementById('setting-technician');
const peopleListEl = document.getElementById('setting-people');
const personForm = document.getElementById('setting-person-form');
const personInput = document.getElementById('setting-person');
const outDaysInput = document.getElementById('setting-out-days');

function renderPeople() {
  const { people } = loadSettings();
  peopleListEl.innerHTML = '';
  if (people.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'people-empty';
    empty.textContent = 'No names yet.';
    peopleListEl.appendChild(empty);
    return;
  }
  people.forEach((name) => {
    const chip = document.createElement('span');
    chip.className = 'people-chip';
    chip.appendChild(document.createTextNode(name));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.title = `Remove ${name}`;
    remove.setAttribute('aria-label', `Remove ${name}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      const settings = loadSettings();
      settings.people = settings.people.filter((person) => person !== name);
      saveSettings(settings);
      renderPeople();
    });
    chip.appendChild(remove);
    peopleListEl.appendChild(chip);
  });
}

technicianInput.addEventListener('input', () => {
  const settings = loadSettings();
  settings.technician = technicianInput.value.trim();
  saveSettings(settings);
});

personForm.addEventListener('submit', (event) => {
  event.preventDefault();
  rememberPerson(personInput.value);
  personInput.value = '';
  renderPeople();
});

// A whole number of days, at least one.
restrictInput(outDaysInput, (text) => text.replace(/[^0-9]/g, '').slice(0, 3));
outDaysInput.addEventListener('change', () => {
  const settings = loadSettings();
  const days = parseInt(outDaysInput.value, 10);
  settings.outTooLongDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_OUT_TOO_LONG_DAYS;
  saveSettings(settings);
  outDaysInput.value = String(settings.outTooLongDays);
});

// --- Worksheet page ---
// What the Worksheet page makes (history.js's recordMode) — the one
// switch between an unofficial record and a worksheet. Worksheets
// started from now on follow it, and so does one already open that
// has no readings in it yet; one with readings keeps the table it has
// (interpolate.js).
const recordModeTabs = document.querySelectorAll('#record-mode-tabs .input-tab');
const recordModeHint = document.getElementById('record-mode-hint');
const RECORD_MODE_HINTS = {
  unofficial: 'A simple table of readings: Lab Rdg, UUT Rdg and the corrections.',
  worksheet: 'Each worksheet has a "Type of worksheet" to choose, and its tables follow that worksheet\'s raw data sheet (F16, F26, F27, F29, F33, F35, F39).',
};

function syncRecordMode() {
  const { recordMode } = loadSettings();
  recordModeTabs.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.recordMode === recordMode);
    btn.setAttribute('aria-pressed', String(btn.dataset.recordMode === recordMode));
  });
  recordModeHint.textContent = RECORD_MODE_HINTS[recordMode];
}

recordModeTabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    const settings = loadSettings();
    settings.recordMode = btn.dataset.recordMode;
    saveSettings(settings);
    syncRecordMode();
  });
});

hydrateStorage([SETTINGS_KEY]).then(() => {
  const settings = loadSettings();
  syncRecordMode();
  technicianInput.value = settings.technician;
  outDaysInput.value = String(settings.outTooLongDays);
  renderPeople();
});

// --- Stored on this device ---
// Scan/record counts come from history.js's store. When that's saving
// to a storage folder, the folder's path is shown and the rest is
// skipped: used/quota and persistence come from the browser's Storage
// API (a share of the device's actual free disk rather than a fixed
// per-origin ceiling), and only describe data kept in the browser.
function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${n} B`;
}

const storageScansEl = document.getElementById('storage-scans');
const storageRecordsEl = document.getElementById('storage-records');
const storageLabLogEl = document.getElementById('storage-lablog');
const storageShareLogEl = document.getElementById('storage-sharelog');
const storageUsedEl = document.getElementById('storage-used');
const storageQuotaEl = document.getElementById('storage-quota');
const storageLocationNoteEl = document.getElementById('storage-location-note');
const storagePersistNoteEl = document.getElementById('storage-persist-note');
const storagePersistBtnEl = document.getElementById('storage-persist-btn');

async function refreshStorageStats() {
  await hydrateStorage([HISTORY_KEY, UUT_DATABASE_KEY, LAB_LOG_KEY, SHARE_LOG_KEY]);
  storageScansEl.textContent = String(loadHistory().length);
  storageRecordsEl.textContent = String(loadUutDatabase().length);
  storageLabLogEl.textContent = String(loadLabLog().length);
  storageShareLogEl.textContent = String(loadShareLog().length);

  const folderLocation = await getStorageFolderLocation();
  if (folderLocation) {
    storageLocationNoteEl.textContent = `Saved as files in ${folderLocation}`;
    storageLocationNoteEl.classList.remove('hidden');
    storageUsedEl.parentElement.classList.add('hidden');
    storageQuotaEl.parentElement.classList.add('hidden');
    return;
  }

  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage, quota } = await navigator.storage.estimate();
      storageUsedEl.textContent = formatBytes(usage);
      storageQuotaEl.textContent = formatBytes(quota);
    } catch {
      storageUsedEl.textContent = '—';
      storageQuotaEl.textContent = '—';
    }
  }

  if (navigator.storage && navigator.storage.persisted) {
    try {
      const persistent = await navigator.storage.persisted();
      if (persistent) {
        storagePersistNoteEl.textContent = 'Storage is persistent — the browser won’t clear it under storage pressure.';
        storagePersistNoteEl.classList.remove('hidden');
        storagePersistBtnEl.classList.add('hidden');
      } else if (navigator.storage.persist) {
        storagePersistNoteEl.textContent = 'Not yet persistent — under storage pressure, the browser could clear this.';
        storagePersistNoteEl.classList.remove('hidden');
        storagePersistBtnEl.classList.remove('hidden');
      }
    } catch {
      // No persistence info available — leave the note hidden rather
      // than guess at a status that couldn't actually be read.
    }
  }
}

storagePersistBtnEl.addEventListener('click', async () => {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch {
    // Denied or unsupported — refreshStorageStats() below still shows
    // whatever the real, current state ends up being.
  }
  refreshStorageStats();
});

refreshStorageStats();

// --- Backup ---
// The making and reading of backup files is backup.js; this is its two
// buttons and what they report. A restore replaces everything in the
// app, so it shows what the file holds and asks before it does.
const backupNowBtn = document.getElementById('backup-now');
const backupRestoreBtn = document.getElementById('backup-restore');
const backupFileInput = document.getElementById('backup-file');
const backupLastEl = document.getElementById('backup-last');
const backupNoteEl = document.getElementById('backup-note');
const RESTORED_NOTE_KEY = 'certqr:restoredNote';

function showBackupNote(text, isError) {
  backupNoteEl.textContent = text;
  backupNoteEl.classList.toggle('hidden', !text);
  backupNoteEl.classList.toggle('scan-status-error', Boolean(isError));
}

function refreshLastBackup() {
  const at = lastBackupAt();
  backupLastEl.textContent = at ? `Last backed up: ${formatSavedAt(at)}` : 'Not backed up yet.';
}

backupNowBtn.addEventListener('click', async () => {
  backupNowBtn.disabled = true;
  showBackupNote('Preparing the backup…');
  try {
    const result = await backUpEverything();
    const holds = describeBackupCounts(result.counts);
    const missing = result.missingPhotos > 0 ? ` ${result.missingPhotos} photo${result.missingPhotos === 1 ? '' : 's'} could not be found and ${result.missingPhotos === 1 ? 'is' : 'are'} not in it.` : '';
    const onPhone = result.savedTo ? ` A copy is on this phone in ${result.savedTo}.` : '';
    if (result.outcome === 'shared') showBackupNote(`Backup made: ${holds}.${onPhone}${missing}`);
    else if (result.outcome === 'downloaded') showBackupNote(`Backup saved as ${result.fileName}: ${holds}.${missing}`);
    else if (result.savedTo) showBackupNote(`Backup made: ${holds}. It is only on this phone so far (${result.savedTo}) — keep a copy somewhere else too.${missing}`);
    else if (result.outcome === 'cancelled') showBackupNote('No backup was made.');
    else showBackupNote('The backup could not be made.', true);
  } catch (err) {
    showBackupNote(`The backup could not be made: ${(err && err.message) || err}`, true);
  } finally {
    backupNowBtn.disabled = false;
    refreshLastBackup();
  }
});

backupRestoreBtn.addEventListener('click', () => backupFileInput.click());
backupFileInput.addEventListener('change', async () => {
  const file = backupFileInput.files && backupFileInput.files[0];
  backupFileInput.value = '';
  if (!file) return;
  showBackupNote('Reading the backup…');
  try {
    const backup = await readBackup(new Uint8Array(await file.arrayBuffer()));
    const made = formatSavedAt(backup.info.createdAt) || 'an unknown date';
    const question = [
      `Restore the backup made on ${made}?`,
      '',
      `It holds: ${describeBackupCounts(backup.counts)}.`,
      '',
      'This REPLACES everything in the app now with what is in the backup. Anything added since that backup was made will be lost.',
    ].join('\n');
    if (!window.confirm(question)) {
      showBackupNote('Nothing was restored.');
      return;
    }
    showBackupNote('Restoring…');
    await applyBackup(backup);
    // Said again after the reload that shows the restored data.
    try {
      sessionStorage.setItem(RESTORED_NOTE_KEY, `Restored the backup made on ${made}: ${describeBackupCounts(backup.counts)}.`);
    } catch {
      // The note is all that goes missing.
    }
    window.location.reload();
  } catch (err) {
    showBackupNote(`That backup could not be restored: ${(err && err.message) || err}`, true);
  }
});

refreshLastBackup();
try {
  const restoredNote = sessionStorage.getItem(RESTORED_NOTE_KEY);
  if (restoredNote) {
    sessionStorage.removeItem(RESTORED_NOTE_KEY);
    showBackupNote(restoredNote);
  }
} catch {
  // No note to show.
}

// --- Check for updates ---
// The repo (JacksonCNN/certificate-qr-decoder) is private, so an
// unauthenticated request can't see its releases (GitHub returns 404
// rather than 403, to avoid even confirming a private repo exists) —
// GITHUB_TOKEN (github-token.js) is a fine-grained PAT scoped to just
// this repo, read-only, that authenticates the check. APP_VERSION
// (version.js) is baked into the copy of the app actually running right
// now; bump it to match whenever you cut a new release.
//
// The checking itself, and — in the Android app — downloading a newer
// release and switching to it, is updater.js. This is the part of it
// that shows: what version is running, what a check found, how far a
// download has got, and a button to switch to a downloaded update now
// rather than the next time the app is opened. A copy of the app in a
// browser can't update itself ("updating" there means re-pulling the
// repo), so there it only says that a newer version exists.

const currentVersionEl = document.getElementById('current-version');
const updateNoteEl = document.getElementById('update-note');
const updateBannerEl = document.getElementById('update-banner');
const checkUpdateBtn = document.getElementById('check-update-btn');
const updateRestartBtn = document.getElementById('update-restart-btn');

currentVersionEl.textContent = `v${APP_VERSION}`;

function showUpdateNote(text) {
  updateBannerEl.classList.add('hidden');
  updateNoteEl.textContent = text;
  updateNoteEl.classList.remove('hidden');
}

function showUpdateBanner(level, icon, message, link) {
  updateNoteEl.classList.add('hidden');
  updateBannerEl.innerHTML = '';
  updateBannerEl.className = `due-banner due-banner-${level}`;

  const iconSpan = document.createElement('span');
  iconSpan.className = 'due-banner-icon';
  iconSpan.textContent = icon;
  updateBannerEl.appendChild(iconSpan);

  const textSpan = document.createElement('span');
  textSpan.textContent = link ? `${message} ` : message;
  if (link) {
    const anchor = document.createElement('a');
    anchor.href = link.href;
    anchor.textContent = link.text;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.style.color = 'inherit';
    textSpan.appendChild(anchor);
  }
  updateBannerEl.appendChild(textSpan);

  updateBannerEl.classList.remove('hidden');
}

// What a finished check (updater.js's checkForUpdate) found, in words.
function showUpdateResult(result) {
  const { status, release } = result;
  const titleSuffix = release.name && release.name !== release.tag ? ` — ${release.name}` : '';
  updateRestartBtn.classList.toggle('hidden', status !== 'staged');
  if (status === 'current') {
    showUpdateBanner('safe', '✓', `You're on the latest version (v${APP_VERSION}).`);
  } else if (status === 'staged') {
    showUpdateBanner('aware', '🔔', `Version ${release.version} has been downloaded${titleSuffix}. It will be used the next time the app is opened — or restart now.`);
  } else if (status === 'needs-install') {
    showUpdateBanner('aware', '🔔', `Version ${release.version} is available (you have v${APP_VERSION}), but it can't be downloaded into this install — the app itself needs reinstalling for it.`);
  } else if (status === 'failed') {
    showUpdateBanner('aware', '🔔', `Version ${release.version} is available (you have v${APP_VERSION}), but it couldn't be downloaded just now: ${result.error} It will be tried again later.`);
  } else {
    // 'available' — a newer release, and nothing here that can fetch it.
    showUpdateBanner(
      'aware',
      '🔔',
      `A newer version is available: v${release.version} (you have v${APP_VERSION})${titleSuffix}. See what's new on`,
      { href: release.url, text: 'GitHub' },
    );
  }
}

async function checkForUpdates() {
  if (!hasGithubToken()) {
    showUpdateNote('No GitHub token configured yet — add one in github-token.js to enable update checks.');
    return;
  }

  checkUpdateBtn.disabled = true;
  const originalLabel = checkUpdateBtn.textContent;
  checkUpdateBtn.textContent = 'Checking…';
  showUpdateNote('Checking for updates…');

  try {
    showUpdateResult(await checkForUpdate((done, total) => {
      showUpdateNote(`Downloading the new version… ${done} of ${total} files`);
    }));
  } catch (err) {
    // Offline, GitHub unreachable, token expired/revoked/wrong scope,
    // no releases published yet, etc. — this app works fully offline
    // otherwise, so a failed check here is expected sometimes, not
    // necessarily an error worth alarming over. The underlying error is
    // appended (not just a generic message) since "offline vs. GitHub
    // unreachable vs. bad token vs. something else" are each fixed a
    // different way, and this is the only place that ever sees which.
    const detail = err && err.name === 'TimeoutError' ? 'timed out after 10s' : (err && err.message) || String(err);
    showUpdateNote(`Couldn't check for updates — you may be offline, GitHub may be unreachable, or the token in github-token.js may need renewing. (${detail})`);
  } finally {
    checkUpdateBtn.disabled = false;
    checkUpdateBtn.textContent = originalLabel;
  }
}

checkUpdateBtn.addEventListener('click', checkForUpdates);
// Switches to the downloaded version straight away; the page reloads
// into it (and lands on the app's first page).
updateRestartBtn.addEventListener('click', async () => {
  updateRestartBtn.disabled = true;
  try {
    if (!(await applyStagedUpdate())) updateRestartBtn.classList.add('hidden');
  } catch (err) {
    showUpdateNote(`Couldn't switch to the new version: ${(err && err.message) || err}`);
  } finally {
    updateRestartBtn.disabled = false;
  }
});
checkForUpdates();
