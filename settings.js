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

// --- Technician ---
// history.js's settings: who uses this phone, and how long out is too
// long. Each is saved as it's changed. Signed in to a shared server,
// the technician is whoever is signed in, so it isn't shown
// (history.js's loadSettings). It's also who takes equipment out on
// the Lab Log.
const technicianInput = document.getElementById('setting-technician');
const technicianRow = document.getElementById('setting-technician-row');
const outDaysInput = document.getElementById('setting-out-days');

function renderTechnician() {
  const fromServer = serverSettingsPeople();
  const fixed = Boolean(fromServer && fromServer.technician);
  // Signed in: the name you're signed in under is used by itself, so
  // there's nothing to fill in.
  technicianRow.classList.toggle('hidden', fixed);
  technicianInput.readOnly = fixed;
  if (fixed || document.activeElement !== technicianInput) technicianInput.value = loadSettings().technician;
}

window.addEventListener('certqr:server-account', renderTechnician);

technicianInput.addEventListener('input', () => {
  if (technicianInput.readOnly) return;
  const settings = loadSettings();
  settings.technician = technicianInput.value.trim();
  saveSettings(settings);
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

// --- Reminder about equipment still out (reminders.js) ---
// This phone's own choice, off at first. Turning it on asks to be
// allowed to show notifications; refused, the floating button still
// shows what's out.
const reminderCheck = document.getElementById('setting-reminder');
const reminderTimeRow = document.getElementById('setting-reminder-time-row');
const reminderTimeInput = document.getElementById('setting-reminder-time');
const reminderHint = document.getElementById('setting-reminder-hint');

function renderReminder(note) {
  const reminder = loadOutReminder();
  reminderCheck.checked = reminder.on;
  reminderTimeInput.value = reminder.time;
  reminderTimeRow.classList.toggle('hidden', !reminder.on);
  if (note) {
    reminderHint.textContent = note;
    return;
  }
  const support = outReminderSupport();
  if (!reminder.on) reminderHint.textContent = '';
  else if (support === 'native') reminderHint.textContent = 'Every day, even with the app closed.';
  else if (support === 'browser') reminderHint.textContent = 'Shown when the app is open after this time.';
  else if (support === 'button-only') reminderHint.textContent = 'Only the button for now: install the latest app to get notifications.';
  else reminderHint.textContent = 'Notifications are not supported here; the button still works.';
}

reminderCheck.addEventListener('change', async () => {
  const on = reminderCheck.checked;
  saveOutReminder({ ...loadOutReminder(), on });
  let note = '';
  if (on && outReminderSupport() !== 'button-only' && outReminderSupport() !== 'none') {
    let allowed = false;
    try {
      allowed = await askNotificationPermission();
    } catch {
      allowed = false;
    }
    if (!allowed) note = 'Notifications are blocked for this app. Allow them in the phone settings; the button still works.';
  }
  renderReminder(note);
  await refreshOutReminders();
});

reminderTimeInput.addEventListener('change', async () => {
  if (!/^\d{2}:\d{2}$/.test(reminderTimeInput.value)) return;
  // A new time: today's may still be to come.
  saveOutReminder({ ...loadOutReminder(), time: reminderTimeInput.value, shownOn: '' });
  await refreshOutReminders();
});

renderReminder();

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
  worksheet: 'Each worksheet has a "Type of worksheet" to choose from the worksheet templates below, and is laid out as that template: its questions, and its tables of readings.',
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

hydrateStorage([SETTINGS_KEY, WORKSHEET_TEMPLATES_KEY]).then(() => {
  const settings = loadSettings();
  syncRecordMode();
  outDaysInput.value = String(settings.outTooLongDays);
  renderTechnician();
  renderTemplatesPanel();
});

// --- Worksheet templates ---
// The kinds of worksheet the Worksheet page offers on "Worksheet":
// forms designed in Digital Worksheet Designer and exported there as
// .calfrm files. Everyone sees the list; an admin, signed in to the
// shared server, adds them (the server opens the file), puts a newer
// version of one in its place, renames or removes them. Worksheets
// already begun on a template that's removed are finished on the copy
// they keep (interpolate.js).
const templatesIntro = document.getElementById('templates-intro');
const templatesRows = document.getElementById('templates-rows');
const templatesActions = document.getElementById('templates-actions');
const templateFileInput = document.getElementById('template-file');
const templateImportBtn = document.getElementById('template-import');
const templatesNote = document.getElementById('templates-note');
// Which template "Replace" was pressed for, while the file is picked.
let templateReplaceId = null;

function showTemplatesNote(text, isError) {
  templatesNote.textContent = text;
  templatesNote.classList.toggle('hidden', !text);
  templatesNote.classList.toggle('scan-status-error', Boolean(isError));
}

// "3 questions, 2 tables" — what's in a template.
function templateContents(template) {
  const items = template.form.items || [];
  const tables = items.filter((it) => it.type === 'calibration').length;
  const questions = items.filter((it) => it.type !== 'section' && it.type !== 'calibration').length;
  const parts = [];
  if (questions) parts.push(`${questions} question${questions === 1 ? '' : 's'}`);
  if (tables) parts.push(`${tables} table${tables === 1 ? '' : 's'}`);
  return parts.join(', ') || 'empty';
}

function renderTemplatesPanel() {
  const admin = canManageWorksheetTemplates();
  const connected = Boolean(loadServerConfig());
  const templates = loadWorksheetTemplates();
  templatesActions.classList.toggle('hidden', !admin);
  if (admin) templatesIntro.textContent = 'Design a worksheet in Digital Worksheet Designer, export it there as a .calfrm file, and import it here. Every phone signed in to the shared server gets it, and keeps a copy for working offline.';
  else if (connected) templatesIntro.textContent = 'The kinds of worksheet the Worksheet page offers. An admin adds and changes them.';
  else templatesIntro.textContent = 'The kinds of worksheet the Worksheet page offers come from the shared server, where an admin adds them. Connect to the server (Shared server, above) to get them.';

  templatesRows.innerHTML = '';
  if (templates.length === 0) {
    templatesRows.appendChild(Object.assign(document.createElement('p'), { className: 'camera-note', textContent: 'No worksheet templates yet.' }));
    return;
  }
  templates.forEach((template) => {
    const row = document.createElement('div');
    row.className = 'server-person';
    const head = document.createElement('div');
    head.className = 'server-person-head';
    const name = document.createElement('span');
    name.className = 'server-person-name';
    name.textContent = template.name || template.form.title || 'Untitled template';
    const about = document.createElement('span');
    about.className = 'server-person-id';
    const when = template.updatedAt || template.importedAt;
    about.textContent = [templateContents(template), when ? `updated ${formatSavedAt(when)}${template.updatedBy || template.importedBy ? ` by ${template.updatedBy || template.importedBy}` : ''}` : ''].filter(Boolean).join(' · ');
    head.append(name, about);
    row.appendChild(head);

    if (admin) {
      const actions = document.createElement('div');
      actions.className = 'server-person-actions';
      actions.append(
        serverPersonButton('Rename', () => {
          const next = window.prompt('Name of this worksheet template:', name.textContent);
          if (next === null || !next.trim()) return;
          saveWorksheetTemplates(loadWorksheetTemplates().map((t) => (t.id === template.id ? { ...t, name: next.trim() } : t)));
          showTemplatesNote(`Renamed to “${next.trim()}”.`);
          renderTemplatesPanel();
        }),
        serverPersonButton('Replace…', () => {
          templateReplaceId = template.id;
          templateFileInput.click();
        }),
        serverPersonButton('Remove', () => {
          if (!window.confirm(`Remove the worksheet template “${name.textContent}”?\n\nIt is no longer offered for new worksheets. Worksheets already begun on it can still be finished, and saved records keep everything they show.`)) return;
          saveWorksheetTemplates(loadWorksheetTemplates().filter((t) => t.id !== template.id));
          showTemplatesNote(`Removed “${name.textContent}”.`);
          renderTemplatesPanel();
        }),
      );
      row.appendChild(actions);
    }
    templatesRows.appendChild(row);
  });
}

templateImportBtn.addEventListener('click', () => {
  templateReplaceId = null;
  templateFileInput.click();
});

templateFileInput.addEventListener('change', async () => {
  const file = templateFileInput.files && templateFileInput.files[0];
  templateFileInput.value = '';
  if (!file) return;
  const replaceId = templateReplaceId;
  templateReplaceId = null;
  templateImportBtn.disabled = true;
  showTemplatesNote(`Opening ${file.name}…`);
  try {
    const template = await importWorksheetTemplate(file, replaceId);
    showTemplatesNote(replaceId
      ? `“${template.name}” now uses the new version of the form (${templateContents(template)}).`
      : `Added “${template.name}” (${templateContents(template)}). It's in “Type of worksheet” on the Worksheet page.`);
  } catch (err) {
    showTemplatesNote(err.message || String(err), true);
  } finally {
    templateImportBtn.disabled = false;
    renderTemplatesPanel();
  }
});

window.addEventListener('certqr:server-account', renderTemplatesPanel);

// --- Shared server ---
// Signing in, switching account and signing out are the login page's
// (login.html); here, how syncing is going, Sync now, the way to
// Profile, and — for an admin — who can sign in.
const serverConnectedEl = document.getElementById('server-connected');
const serverStatusEl = document.getElementById('server-status');
const serverSyncBtn = document.getElementById('server-sync');
const serverNoteEl = document.getElementById('server-note');

function showServerNote(text) {
  serverNoteEl.textContent = text;
  serverNoteEl.classList.toggle('hidden', !text);
}

function serverStatusText(config, status) {
  const who = `${config.url} — signed in as ${config.userName || config.userId}${config.admin ? ' (admin)' : ''}.`;
  const waiting = status.pending === 1 ? '1 collection has changes waiting to be sent' : `${status.pending} collections have changes waiting to be sent`;
  if (config.signedOut || status.state === 'signed-out') {
    return `${config.url} — ${config.userName || config.userId} has been signed out (the password was changed, or the account turned off). Changes made here are kept on this phone, and sent once you sign in again.`;
  }
  switch (status.state) {
    case 'offline':
      return `${who} Can't reach the server right now${status.message ? ` (${status.message})` : ''}. ${status.pending > 0 ? `${waiting}; they'll go when it's back.` : 'Working from this phone\'s copy.'}`;
    case 'error':
      return `${who} Couldn't sync: ${status.message}. ${status.pending > 0 ? `${waiting}.` : ''}`;
    default:
      if (status.pending > 0) return `${who} ${waiting}.`;
      return `${who} Up to date${status.lastSyncAt ? ` (synced ${formatTime(status.lastSyncAt)})` : ''}.`;
  }
}

function renderServerPanel() {
  const config = loadServerConfig();
  serverStatusEl.classList.toggle('hidden', !config);
  if (config) serverStatusEl.textContent = serverStatusText(config, getServerStatus());
  serverConnectedEl.classList.toggle('hidden', !config);
  serverSyncBtn.classList.toggle('hidden', Boolean(config && config.signedOut));
  renderServerPeoplePanel();
  renderTemplatesPanel();
  renderTechnician();
}

window.addEventListener('certqr:server-status', renderServerPanel);

serverSyncBtn.addEventListener('click', async () => {
  serverSyncBtn.disabled = true;
  showServerNote('');
  try {
    await flushServerQueue();
    await hydrateStorage(Object.keys(SERVER_COLLECTIONS));
    refreshStorageStats();
    await syncPhotosWithServer(true);
  } finally {
    serverSyncBtn.disabled = false;
    renderServerPanel();
  }
});

// --- People (admins) ---
const serverPeoplePanel = document.getElementById('people-panel');
const serverPeopleRows = document.getElementById('people-rows');
const serverPeopleRefresh = document.getElementById('people-refresh');
const serverPeopleNote = document.getElementById('people-note');
const serverPersonForm = document.getElementById('person-form');
const serverPersonName = document.getElementById('person-name');
const serverPersonLogin = document.getElementById('person-login');
const serverPersonPassword = document.getElementById('person-password');
const serverPersonSuggest = document.getElementById('person-password-suggest');
const serverPersonAdmin = document.getElementById('person-admin');
const serverPersonAddBtn = document.getElementById('person-add');
const serverInviteBox = document.getElementById('server-invite-box');
const serverInviteQr = document.getElementById('server-invite-qr');
const serverInviteAbout = document.getElementById('server-invite-about');
const serverInviteShare = document.getElementById('server-invite-share');
const serverInviteClose = document.getElementById('server-invite-close');
let serverPeopleLoaded = false;
// The invite on show: { name, link }.
let shownInvite = null;

// Makes a one-time invite for `person` and shows it as a QR code at the
// top of the panel, for them to scan in their own app.
async function showInvite(person) {
  try {
    const { link, expiresAt } = await createServerInvite(person.id);
    serverInviteQr.innerHTML = qrSvg(link, `Invite QR for ${person.name}`);
    serverInviteAbout.textContent = `Invite for ${person.name} (login ID "${person.id}"). They open the app, tap Scan QR to sign in, and choose their own password. Works once, until ${formatSavedAt(expiresAt)}. Making a new invite cancels this one.`;
    shownInvite = { name: person.name, link };
    serverInviteBox.classList.remove('hidden');
    serverInviteBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showServerPeopleNote('');
  } catch (err) {
    showServerPeopleNote(err.message || String(err), true);
  }
  loadServerPeople();
}

function closeInvite() {
  shownInvite = null;
  serverInviteQr.innerHTML = '';
  serverInviteBox.classList.add('hidden');
}

serverInviteClose.addEventListener('click', closeInvite);

// For someone who isn't here to scan: the invite as a link, through the
// phone's share sheet (or copied). They paste it into Login ID on the sign-in page.
serverInviteShare.addEventListener('click', async () => {
  if (!shownInvite) return;
  const text = `Your invite to the Certificate QR shared server. Copy this whole link, then open the app and paste it into Login ID on the sign-in page → Sign in. It works once, within 24 hours, and lets whoever opens it first choose the password, so send it only to ${shownInvite.name}.\n\n${shownInvite.link}`;
  const result = await shareText(`Invite for ${shownInvite.name}`, text);
  if (result.outcome === 'copied') showServerPeopleNote('The invite link has been copied. Paste it into a message to them.');
  else if (result.outcome === 'failed') showServerPeopleNote('Couldn\'t share or copy the link here.', true);
});

function showServerPeopleNote(text, isError) {
  serverPeopleNote.textContent = text;
  serverPeopleNote.classList.toggle('hidden', !text);
  serverPeopleNote.classList.toggle('scan-status-error', Boolean(isError));
}

function isServerAdmin() {
  const config = loadServerConfig();
  return Boolean(config && config.admin && !config.signedOut);
}

function renderServerPeoplePanel() {
  const admin = isServerAdmin();
  serverPeoplePanel.classList.toggle('hidden', !admin);
  if (admin && !serverPeopleLoaded) loadServerPeople();
}

// Easy to read out and type: no 0/O, 1/l/I (the same shape as the Pi's
// manage-users.mjs makes).
function suggestPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const pick = (set, count) => Array.from(crypto.getRandomValues(new Uint8Array(count)), (b) => set[b % set.length]).join('');
  return `${pick(letters, 4)}-${pick(digits, 4)}-${pick(letters, 4)}`;
}

function loginIdFromName(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function serverPersonButton(text, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'text-btn';
  btn.textContent = text;
  btn.addEventListener('click', onClick);
  return btn;
}

function serverPersonTag(text) {
  const tag = document.createElement('span');
  tag.className = 'server-person-tag';
  tag.textContent = text;
  return tag;
}

// Runs one change to a person, then shows the list as it now is.
async function changeServerPerson(work, doneText) {
  try {
    await work();
    showServerPeopleNote(doneText);
  } catch (err) {
    showServerPeopleNote(err.message || String(err), true);
  }
  loadServerPeople();
}

function renderServerPeople(people) {
  const config = loadServerConfig();
  const me = config ? config.userId : '';
  serverPeopleRows.innerHTML = '';
  people
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((person) => {
      const row = document.createElement('div');
      row.className = `server-person${person.disabled ? ' server-person-off' : ''}`;

      const head = document.createElement('div');
      head.className = 'server-person-head';
      const name = document.createElement('span');
      name.className = 'server-person-name';
      name.textContent = person.name;
      const id = document.createElement('span');
      id.className = 'server-person-id';
      id.textContent = `login: ${person.id}`;
      head.append(name, id);
      if (person.id === me) head.appendChild(serverPersonTag('You'));
      if (person.admin) head.appendChild(serverPersonTag('Admin'));
      if (person.readOnly) head.appendChild(serverPersonTag('Read-only'));
      if (person.disabled) head.appendChild(serverPersonTag('Turned off'));
      if (!person.hasPassword) head.appendChild(serverPersonTag(person.invitePending ? 'Invited' : 'Not joined yet'));
      row.appendChild(head);

      const actions = document.createElement('div');
      actions.className = 'server-person-actions';
      if (person.id !== me && !person.disabled) {
        actions.appendChild(serverPersonButton('Invite QR', () => {
          if (person.hasPassword && !window.confirm(`${person.name} already has a password.\n\nAn invite lets them choose a new one, which signs them out on their other devices. Make an invite?`)) return;
          showInvite(person);
        }));
      }
      actions.appendChild(serverPersonButton('Reset password', () => {
        const password = window.prompt(`New password for ${person.name} (at least 8 characters).\n\nThey'll be signed out on every device and need this to sign in again.`, suggestPassword());
        if (password == null) return;
        changeServerPerson(() => updateServerPerson(person.id, { password }), `New password set for ${person.name}: ${password} — give it to them; they can change it in Settings.`);
      }));
      if (person.id !== me) {
        actions.appendChild(serverPersonButton(person.disabled ? 'Turn on' : 'Turn off', () => {
          if (!person.disabled && !window.confirm(`Turn off ${person.name}?\n\nThey're signed out on every device and can't sign in until turned back on. Nothing they saved is deleted.`)) return;
          changeServerPerson(() => updateServerPerson(person.id, { disabled: !person.disabled }), `${person.name} turned ${person.disabled ? 'back on' : 'off'}.`);
        }));
        actions.appendChild(serverPersonButton(person.admin ? 'Not admin' : 'Make admin', () => {
          changeServerPerson(() => updateServerPerson(person.id, { admin: !person.admin }), `${person.name} ${person.admin ? 'is no longer an admin' : 'is now an admin'}.`);
        }));
        actions.appendChild(serverPersonButton('Remove', () => {
          if (!window.confirm(`Remove ${person.name} (login ${person.id})?\n\nThey can't sign in any more. Everything they saved stays in the shared data.`)) return;
          changeServerPerson(() => removeServerPerson(person.id), `${person.name} removed.`);
        }));
      }
      row.appendChild(actions);
      serverPeopleRows.appendChild(row);
    });
}

async function loadServerPeople() {
  if (!isServerAdmin()) return;
  serverPeopleLoaded = true;
  try {
    renderServerPeople(await listServerPeople());
  } catch (err) {
    showServerPeopleNote(err.message || String(err), true);
  }
}

serverPeopleRefresh.addEventListener('click', () => {
  showServerPeopleNote('');
  loadServerPeople();
});

// The login ID follows the name until it's typed in itself.
let serverPersonLoginEdited = false;
serverPersonName.addEventListener('input', () => {
  if (!serverPersonLoginEdited) serverPersonLogin.value = loginIdFromName(serverPersonName.value.split(/\s+/)[0] || '');
});
serverPersonLogin.addEventListener('input', () => {
  serverPersonLoginEdited = serverPersonLogin.value !== '';
});
serverPersonSuggest.addEventListener('click', () => {
  serverPersonPassword.value = suggestPassword();
});

serverPersonForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const person = {
    name: serverPersonName.value.trim(),
    id: serverPersonLogin.value.trim().toLowerCase(),
    password: serverPersonPassword.value,
    admin: serverPersonAdmin.checked,
  };
  serverPersonAddBtn.disabled = true;
  try {
    await addServerPerson(person);
    serverPersonForm.reset();
    serverPersonLoginEdited = false;
    if (person.password) {
      showServerPeopleNote(`${person.name} added. Give them: server ${loadServerConfig().url}, login ID ${person.id}, password ${person.password}. They can change the password in Settings.`);
    } else {
      // No password: their invite, straight away.
      await showInvite(person);
    }
  } catch (err) {
    showServerPeopleNote(err.message || String(err), true);
  } finally {
    serverPersonAddBtn.disabled = false;
    loadServerPeople();
  }
});

renderServerPanel();
// Whether this person is (still) an admin may have changed since they
// signed in.
if (loadServerConfig() && !loadServerConfig().signedOut) {
  refreshServerAccount().then(renderServerPanel).catch(() => {});
}

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
const storageLocalTitleEl = document.getElementById('storage-local-title');
const storageServerEl = document.getElementById('storage-server');
const storageServerScansEl = document.getElementById('storage-server-scans');
const storageServerRecordsEl = document.getElementById('storage-server-records');
const storageServerLabLogEl = document.getElementById('storage-server-lablog');
const storageServerNoteEl = document.getElementById('storage-server-note');
const storageDeleteEl = document.getElementById('storage-delete');
const deleteServerCheck = document.getElementById('setting-delete-server');
const showHiddenBtn = document.getElementById('storage-show-hidden');
const storageUsedEl = document.getElementById('storage-used');
const storageQuotaEl = document.getElementById('storage-quota');
const storageLocationNoteEl = document.getElementById('storage-location-note');
const storagePersistNoteEl = document.getElementById('storage-persist-note');
const storagePersistBtnEl = document.getElementById('storage-persist-btn');

// --- Photos on this phone (photos.js) ---
// Signed in: this phone's own photos, the downloaded ones kept in the
// cache, and any downloaded before downloads went to the cache — with the
// way to clear the downloaded ones (the server keeps every photo).
const storagePhotosEl = document.getElementById('storage-photos');
const storagePhotosMineEl = document.getElementById('storage-photos-mine');
const storagePhotosCacheEl = document.getElementById('storage-photos-cache');
const storagePhotosOldEl = document.getElementById('storage-photos-old');
const storagePhotosOldRow = document.getElementById('storage-photos-old-row');
const storagePhotosClearBtn = document.getElementById('storage-photos-clear');
const storagePhotosNoteEl = document.getElementById('storage-photos-note');

const photoCount = (n, bytes) => `${n} photo${n === 1 ? '' : 's'} · ${formatBytes(bytes)}`;

async function refreshPhotoStorage() {
  storagePhotosEl.classList.toggle('hidden', !loadServerConfig());
  if (!loadServerConfig()) return;
  try {
    const summary = await photoStorageSummary();
    storagePhotosMineEl.textContent = photoCount(summary.mine.count, summary.mine.bytes);
    storagePhotosCacheEl.textContent = `${photoCount(summary.cache.photos, summary.cache.bytes)}${summary.cache.previews ? ` (+ ${summary.cache.previews} previews)` : ''}`;
    storagePhotosOldEl.textContent = photoCount(summary.downloaded.count, summary.downloaded.bytes);
    storagePhotosOldRow.classList.toggle('hidden', summary.downloaded.count === 0);
    storagePhotosClearBtn.disabled = !summary.canClear;
  } catch {
    storagePhotosMineEl.textContent = '—';
  }
}

function showPhotoNote(text, isError) {
  storagePhotosNoteEl.textContent = text;
  storagePhotosNoteEl.classList.toggle('hidden', !text);
  storagePhotosNoteEl.classList.toggle('scan-status-error', Boolean(isError));
}

storagePhotosClearBtn.addEventListener('click', async () => {
  if (!window.confirm('Clear the photos downloaded to show other phones\' records?\n\nThey stay on the shared server and are downloaded again when you open them. This phone\'s own photos are kept.')) return;
  storagePhotosClearBtn.disabled = true;
  showPhotoNote('Clearing…');
  try {
    const { cleared, bytes, kept } = await clearDownloadedPhotos();
    showPhotoNote(`Cleared ${formatBytes(bytes)}${cleared ? ` (including ${cleared} photo${cleared === 1 ? '' : 's'} downloaded earlier)` : ''}.${kept ? ` ${kept} photo${kept === 1 ? ' isn\'t' : 's aren\'t'} on the server, so ${kept === 1 ? 'it was' : 'they were'} kept.` : ''}`);
  } catch (err) {
    showPhotoNote(err.message || String(err), true);
  }
  refreshPhotoStorage();
});

// Signed in to a shared server, two parts: what this phone keeps
// offline (history.js's partialStorageCounts — all cert data, its own
// records and trips, everything still out), and what the server has,
// as fetched when this page loaded. Not signed in, everything is on
// this phone.
async function refreshStorageStats() {
  await hydrateStorage([HISTORY_KEY, UUT_DATABASE_KEY, LAB_LOG_KEY]);
  refreshPhotoStorage();
  const serverConfig = loadServerConfig();
  storageServerEl.classList.toggle('hidden', !serverConfig);
  storageDeleteEl.classList.toggle('hidden', !serverConfig);
  storageLocalTitleEl.textContent = serverConfig ? 'On this phone (kept offline)' : 'On this phone';
  if (!serverConfig) {
    storageScansEl.textContent = String(loadHistory().length);
    storageRecordsEl.textContent = String(loadUutDatabase().length);
    storageLabLogEl.textContent = String(loadLabLog().length);
  } else {
    const counts = await partialStorageCounts();
    const part = (key) => counts[key] || { kept: 0, hidden: 0, waiting: 0, server: null };
    const show = (el, value) => {
      el.textContent = value == null ? '—' : String(value);
    };
    show(storageScansEl, part(HISTORY_KEY).kept);
    show(storageRecordsEl, part(UUT_DATABASE_KEY).kept);
    show(storageLabLogEl, part(LAB_LOG_KEY).kept);
    show(storageServerScansEl, part(HISTORY_KEY).server);
    show(storageServerRecordsEl, part(UUT_DATABASE_KEY).server);
    show(storageServerLabLogEl, part(LAB_LOG_KEY).server);
    const reached = [HISTORY_KEY, UUT_DATABASE_KEY, LAB_LOG_KEY].every((key) => part(key).server != null);
    storageServerNoteEl.textContent = reached ? '' : 'Couldn\'t reach the server just now; shown when it can be.';
    storageServerNoteEl.classList.toggle('hidden', reached);
    deleteServerCheck.checked = deleteAsksAboutServer();
    const hidden = [HISTORY_KEY, UUT_DATABASE_KEY, LAB_LOG_KEY].reduce((sum, key) => sum + part(key).hidden, 0);
    showHiddenBtn.textContent = `Show items hidden on this phone again (${hidden})`;
    showHiddenBtn.classList.toggle('hidden', hidden === 0);
  }

  if (serverConfig) {
    storageLocationNoteEl.textContent = `Shared on ${serverConfig.url}.`;
    storageLocationNoteEl.classList.remove('hidden');
    storageUsedEl.parentElement.classList.add('hidden');
    storageQuotaEl.parentElement.classList.add('hidden');
    storagePersistNoteEl.classList.add('hidden');
    storagePersistBtnEl.classList.add('hidden');
    return;
  }
  storageUsedEl.parentElement.classList.remove('hidden');
  storageQuotaEl.parentElement.classList.remove('hidden');
  storageLocationNoteEl.classList.add('hidden');

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

deleteServerCheck.addEventListener('change', () => setDeleteAsksAboutServer(deleteServerCheck.checked));

showHiddenBtn.addEventListener('click', async () => {
  showHiddenBtn.disabled = true;
  await showHiddenItems();
  showHiddenBtn.disabled = false;
  showHiddenBtn.textContent = 'Shown again — on the other pages from now on.';
});

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
// app (or, connected to a shared server, is added to what's there —
// see replaceStoredValue), so it shows what the file holds and asks
// before it does.
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
      loadServerConfig()
        ? 'This phone is connected to the shared server, so the backup is ADDED to the shared data: anything in it that is missing comes back, and where both have the same item the backup\'s copy is used. Nothing anyone else added is deleted.'
        : 'This REPLACES everything in the app now with what is in the backup. Anything added since that backup was made will be lost.',
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
