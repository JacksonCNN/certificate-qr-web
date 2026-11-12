// lablog.js — "Lab Log" page. Records when a piece of equipment leaves
// the lab and when it comes back. Scanning the equipment's certificate
// QR is the way in: a scan of something that's in the lab stamps the
// current time as a new trip's outAt, and a scan of something that's
// out stamps that trip's inAt (history.js's LAB_LOG_KEY). The log below
// is those time stamps laid out as events and grouped by the day each
// one happened on — so a trip that goes out on Monday and comes back on
// Tuesday shows up under both days. Each day folds away under its date.
//
// Who took it is picked from the names kept in Settings. What is out is
// flagged when it has been out longer than Settings allows, and when
// its calibration is due or will be within the month.

const takeOutForm = document.getElementById('lab-out-form');
const equipmentInput = document.getElementById('lab-equipment');
const takenByInput = document.getElementById('lab-taken-by');
const peoplePick = document.getElementById('lab-people');
const noteInput = document.getElementById('lab-note');
const equipmentOptions = document.getElementById('lab-equipment-options');
const labStatus = document.getElementById('lab-status');
const outList = document.getElementById('lab-out-list');
const outCount = document.getElementById('lab-out-count');
const logList = document.getElementById('lab-log-list');
const logCount = document.getElementById('lab-log-count');
const shareLogBtn = document.getElementById('share-log');
const toggleAllBtn = document.getElementById('toggle-all-days');
const clearLogBtn = document.getElementById('clear-log');

const SHARE_TITLE = 'Equipment In/Out Log';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const CHEVRON_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>';
const SHARE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.7" x2="15.4" y2="6.3"/><line x1="8.6" y1="13.3" x2="15.4" y2="17.7"/></svg>';
const DELETE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/><line x1="10" y1="11" x2="10" y2="16"/><line x1="14" y1="11" x2="14" y2="16"/></svg>';

// `tone`: true for something that didn't happen, 'warn' for something
// that did but needs a look, nothing for the ordinary case.
function setStatus(text, tone) {
  labStatus.textContent = text;
  labStatus.classList.toggle('scan-status-error', tone === true);
  labStatus.classList.toggle('scan-status-warn', tone === 'warn');
  labStatus.classList.toggle('scan-status-ok', !tone);
}

// --- Dates ---
// dayKey, formatDay and formatTime are history.js's — the Shared Log
// groups by day the same way.

// Time of day alone when `iso` falls on the same day as `relativeToIso`
// (the row it's printed on already sits under that date), the day too
// when it doesn't.
function formatOtherStamp(iso, relativeToIso) {
  return dayKey(iso) === dayKey(relativeToIso) ? formatTime(iso) : `${formatDay(iso)}, ${formatTime(iso)}`;
}

function formatDuration(fromIso, toIso) {
  const minutes = Math.max(0, Math.round((new Date(toIso) - new Date(fromIso)) / 60000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

function entryLabel(entry) {
  return entry.equipmentName ? `${entry.equipmentId} — ${entry.equipmentName}` : entry.equipmentId;
}

// Who took it and what for, as the tail of a line about a trip.
function whoSuffix(entry) {
  const who = [entry.takenBy, entry.note].filter(Boolean).join(' · ');
  return who ? ` · ${who}` : '';
}

// The latest certificate scanned for a piece of equipment, if any.
function latestScan(equipmentId) {
  return loadHistory().find((h) => h.id && h.id.toLowerCase() === String(equipmentId).toLowerCase());
}

// What needs chasing about a trip that isn't over: out longer than
// Settings allows, and calibration due (it went out before the date
// passed) or due within the month.
function outFlags(entry) {
  const flags = [];
  const days = daysOutOfLab(entry);
  if (days > loadSettings().outTooLongDays) flags.push({ level: 'err', text: `Out ${days} days` });
  const scan = latestScan(entry.equipmentId);
  if (scan && isCalibrationDue(scan.due)) flags.push({ level: 'err', text: 'Calibration due' });
  else if (scan && isDueSoon(scan.due)) flags.push({ level: 'warn', text: `Cal. ${dueSoonText(scan.due)}` });
  return flags;
}

// --- Events, grouped by day ---
// Each trip contributes an "out" event and, once returned, an "in"
// event. Days run newest first; within a day, events run in the order
// they happened.
function buildDayGroups(entries) {
  const events = [];
  entries.forEach((entry) => {
    events.push({ type: 'out', at: entry.outAt, entry });
    if (entry.inAt) events.push({ type: 'in', at: entry.inAt, entry });
  });
  events.sort((a, b) => new Date(a.at) - new Date(b.at));

  const groups = new Map();
  events.forEach((event) => {
    const key = dayKey(event.at);
    if (!groups.has(key)) groups.set(key, { key, label: formatDay(event.at), events: [] });
    groups.get(key).events.push(event);
  });
  return Array.from(groups.values()).sort((a, b) => b.key.localeCompare(a.key));
}

// The other half of the trip, as seen from one of its two events.
function eventDetail(event) {
  const { entry } = event;
  if (event.type === 'in') {
    return `out ${formatDuration(entry.outAt, entry.inAt)}, since ${formatOtherStamp(entry.outAt, entry.inAt)}`;
  }
  return entry.inAt ? `returned ${formatOtherStamp(entry.inAt, entry.outAt)}` : 'still out';
}

// --- Sharing ---
// Shared (history.js's shareText) as a checklist: under each day, one
// line per piece of equipment that went out or came back that day,
// ticked once it's back in the lab and left unticked while it's still
// out. WhatsApp and the like have no boxes that can be ticked in a
// message, so the box is a character the app fills in — the list shows
// at a glance what hasn't come back.
const BOX_RETURNED = '☑';
const BOX_STILL_OUT = '☐';

function buildShareText(groups) {
  const lines = [SHARE_TITLE];
  const { technician, outTooLongDays } = loadSettings();
  if (technician) lines.push(`Technician: ${technician}`);
  groups.forEach((group) => {
    lines.push('', group.label);
    const listed = new Set();
    group.events.forEach((event) => {
      const { entry } = event;
      if (listed.has(entry)) return;
      listed.add(entry);
      const who = entry.takenBy ? ` (${entry.takenBy})` : '';
      const note = entry.note ? ` [${entry.note}]` : '';
      const days = daysOutOfLab(entry);
      const stillOut = days > outTooLongDays ? `still out — ${days} days` : 'still out';
      const back = entry.inAt ? `in ${formatOtherStamp(entry.inAt, event.at)}` : stillOut;
      lines.push(`${entry.inAt ? BOX_RETURNED : BOX_STILL_OUT} ${entryLabel(entry)}${who}${note} — out ${formatOtherStamp(entry.outAt, event.at)}, ${back}`);
    });
  });
  return lines.join('\n');
}

// What went out is noted in the shared log (history.js), text and all.
async function shareGroups(groups, title) {
  if (groups.length === 0) return;
  const text = buildShareText(groups);
  const result = await shareText(title, text);
  addShareLogEntry(result, { kind: 'lablog', title, text });
  if (result.outcome === 'copied') setStatus('Log copied to the clipboard — paste it wherever you want to send it.');
  else if (result.outcome === 'failed') setStatus('This browser can\'t share or copy the log.', true);
}

// --- Changes ---
// The trip this equipment is currently out on, if it is out.
function findStillOut(equipmentId) {
  return loadLabLog().find((e) => !e.inAt && e.equipmentId.toLowerCase() === String(equipmentId).toLowerCase());
}

// `label` is the equipment label it was scanned from (scanner.js's
// readEquipmentLabelQr), if it was: its maker, brand and serial number
// are kept on the trip, and describe it when no certificate of it has
// been scanned on this device.
function takeOut(equipmentText, takenBy, note, label) {
  const entries = loadLabLog();
  const stillOut = findStillOut(equipmentText);
  if (stillOut) {
    setStatus(`${stillOut.equipmentId} is already out (since ${formatDay(stillOut.outAt)}, ${formatTime(stillOut.outAt)}) — return it first.`, true);
    return false;
  }
  // The description comes along when this is an ID that's been scanned
  // before, so the log reads as more than a bare ID. So does what's
  // known of its calibration: equipment whose latest scan is past its
  // due date doesn't go out, typed in or not.
  const known = loadHistory().find((h) => h.id && h.id.toLowerCase() === equipmentText.toLowerCase());
  if (known && isCalibrationDue(known.due)) {
    const message = dueEquipmentMessage(known, 'taken out');
    setStatus(message, true);
    window.alert(message);
    return false;
  }
  const entry = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    equipmentId: known ? known.id : equipmentText,
    equipmentName: (known && known.name) || (label ? equipmentLabelDescription(label) : ''),
    ...(label ? { maker: label.maker, brand: label.brand, serial: label.serial } : {}),
    takenBy,
    note,
    outAt: new Date().toISOString(),
    inAt: null,
  };
  entries.unshift(entry);
  saveLabLogEntries(entries);
  // A name that's new is on the list from now on.
  if (rememberPerson(takenBy)) renderPeople();
  const taken = `${entry.equipmentId} taken out at ${formatTime(entry.outAt)}${takenBy ? ` by ${takenBy}` : ''}.`;
  // Still good, so it goes — but with the date in view, so it's back
  // and booked for recalibration in time.
  if (known && isDueSoon(known.due)) setStatus(`${taken} Its calibration is ${dueSoonText(known.due)} (${known.due}) — book the recalibration.`, 'warn');
  else setStatus(taken);
  return true;
}

function returnEntry(id) {
  const entries = loadLabLog();
  const entry = entries.find((e) => e.id === id);
  if (!entry || entry.inAt) return;
  entry.inAt = new Date().toISOString();
  saveLabLogEntries(entries);
  setStatus(`${entry.equipmentId} returned at ${formatTime(entry.inAt)}.`);
}

function deleteEntry(id) {
  saveLabLogEntries(loadLabLog().filter((e) => e.id !== id));
}

// --- Rendering ---
function buildDeleteBtn(entry) {
  const btn = el('button', 'history-item-btn history-item-btn-danger');
  btn.type = 'button';
  btn.title = 'Delete entry';
  btn.setAttribute('aria-label', 'Delete entry');
  btn.innerHTML = DELETE_ICON;
  btn.addEventListener('click', () => {
    const what = entry.inAt ? 'both its out and in time stamps' : 'its out time stamp';
    if (!window.confirm(`Delete this entry for ${entry.equipmentId}? This removes ${what}.`)) return;
    deleteEntry(entry.id);
    render();
  });
  return btn;
}

function renderOutList(entries) {
  const out = entries.filter((e) => !e.inAt);
  outCount.textContent = out.length > 0 ? `(${out.length})` : '';
  outList.innerHTML = '';

  if (out.length === 0) {
    outList.appendChild(el('p', 'history-empty', 'Nothing is out of the lab right now.'));
    return;
  }

  out.forEach((entry) => {
    const row = el('div', 'history-item');

    const info = el('div', 'lab-item-info');
    const heading = el('span', 'history-item-id', entryLabel(entry));
    outFlags(entry).forEach((flag) => heading.appendChild(el('span', `item-flag item-flag-${flag.level}`, flag.text)));
    info.appendChild(heading);
    info.appendChild(el('span', 'history-item-meta', `Out since ${formatDay(entry.outAt)}, ${formatTime(entry.outAt)}${whoSuffix(entry)}`));
    row.appendChild(info);

    const actions = el('div', 'history-item-actions');
    const returnBtn = el('button', 'rescan-btn lab-return-btn', 'Return');
    returnBtn.type = 'button';
    returnBtn.title = 'Record this equipment as back in the lab now';
    returnBtn.addEventListener('click', () => {
      returnEntry(entry.id);
      render();
    });
    actions.appendChild(returnBtn);
    actions.appendChild(buildDeleteBtn(entry));
    row.appendChild(actions);

    outList.appendChild(row);
  });
}

// --- The log, a day at a time ---
// Each day is a heading that folds its events away: a log that has run
// for weeks is a short list of dates, with the day wanted opened up.
// Which days are open is kept for as long as the page is. The newest
// day opens by itself the first time it's seen — today's, usually, the
// one being worked in; every other day starts folded, and from then on
// each stays as it was left.
const openDays = new Set();
const knownDays = new Set();

// A folded day still says what's in it: how many went out, how many
// came in, and — the thing worth opening it for — how many of that
// day's are still out.
function daySummary(group) {
  const outs = group.events.filter((event) => event.type === 'out').length;
  const ins = group.events.length - outs;
  const stillOut = new Set(group.events.filter((event) => !event.entry.inAt).map((event) => event.entry)).size;
  return { text: `${outs} out · ${ins} in`, stillOut };
}

function buildEventRow(event) {
  const row = el('div', 'history-item lab-event');
  row.appendChild(el('span', 'lab-event-time', formatTime(event.at)));
  row.appendChild(el('span', `lab-badge lab-badge-${event.type}`, event.type === 'out' ? 'Out' : 'In'));

  const info = el('div', 'lab-item-info');
  info.appendChild(el('span', 'history-item-id', entryLabel(event.entry)));
  info.appendChild(el('span', 'history-item-meta', `${eventDetail(event)}${whoSuffix(event.entry)}`));
  row.appendChild(info);

  const actions = el('div', 'history-item-actions');
  actions.appendChild(buildDeleteBtn(event.entry));
  row.appendChild(actions);
  return row;
}

function renderLog(entries) {
  const groups = buildDayGroups(entries);
  logCount.textContent = entries.length > 0 ? `(${entries.length})` : '';
  shareLogBtn.disabled = groups.length === 0;
  logList.innerHTML = '';

  groups.forEach((group, index) => {
    if (knownDays.has(group.key)) return;
    knownDays.add(group.key);
    if (index === 0) openDays.add(group.key);
  });
  const allOpen = groups.length > 0 && groups.every((group) => openDays.has(group.key));
  toggleAllBtn.textContent = allOpen ? 'Collapse all' : 'Expand all';
  toggleAllBtn.classList.toggle('hidden', groups.length === 0);

  if (groups.length === 0) {
    logList.appendChild(el('p', 'history-empty', 'No equipment has been logged yet — take something out above and its time stamp shows up here.'));
    return;
  }

  groups.forEach((group) => {
    const open = openDays.has(group.key);
    const day = el('div', 'lab-day');

    const header = el('div', 'lab-day-header');
    const heading = el('h3', 'day-heading');
    const toggle = el('button', 'day-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.innerHTML = CHEVRON_ICON;
    toggle.appendChild(el('span', 'day-toggle-label', group.label));
    const summary = daySummary(group);
    toggle.appendChild(el('span', 'day-toggle-summary', summary.text));
    if (summary.stillOut > 0) toggle.appendChild(el('span', 'day-toggle-flag', `${summary.stillOut} still out`));
    toggle.addEventListener('click', () => {
      if (openDays.has(group.key)) openDays.delete(group.key);
      else openDays.add(group.key);
      renderLog(loadLabLog());
    });
    heading.appendChild(toggle);
    header.appendChild(heading);

    const shareDayBtn = el('button', 'history-item-btn');
    shareDayBtn.type = 'button';
    shareDayBtn.title = `Share ${group.label} only`;
    shareDayBtn.setAttribute('aria-label', `Share ${group.label} only`);
    shareDayBtn.innerHTML = SHARE_ICON;
    shareDayBtn.addEventListener('click', () => shareGroups([group], `${SHARE_TITLE} — ${group.label}`));
    header.appendChild(shareDayBtn);
    day.appendChild(header);

    if (open) group.events.forEach((event) => day.appendChild(buildEventRow(event)));
    logList.appendChild(day);
  });
}

toggleAllBtn.addEventListener('click', () => {
  const groups = buildDayGroups(loadLabLog());
  const allOpen = groups.every((group) => openDays.has(group.key));
  groups.forEach((group) => {
    if (allOpen) openDays.delete(group.key);
    else openDays.add(group.key);
  });
  renderLog(loadLabLog());
});

function render() {
  const entries = loadLabLog();
  renderOutList(entries);
  renderLog(entries);
}

// --- Scanning ---
// One scan does whichever of the two fits: equipment that's out comes
// back in, anything else goes out. The camera (scanner.js) closes after
// each code, so the same code sitting in view can't flip it straight
// back.
//
// Two kinds of code are read: the equipment's certificate QR, and its
// own equipment label (Kanji mode, error-correction level Q, holding its
// ID, maker, brand and serial number — scanner.js's
// readEquipmentLabelQr). A label carries no calibration data, so for
// one the due date is the one from the latest certificate scanned of
// that ID on this device, if any.
//
// Equipment whose calibration is due isn't let out: a message pops up,
// and neither the scan nor a trip is saved. It can still be scanned
// back in — it has to be able to come back.
const qrScanner = createQrScanner({
  root: document.getElementById('scanner'),
  validate(code) {
    const { payload, error, hint, problem } = readCertificateQr(code);
    if (payload) {
      if (isCalibrationDue(payload.due) && !findStillOut(payload.id)) {
        refuseDue(dueCertificateMessage(payload));
        return {};
      }
      return { accepted: { certificate: payload } };
    }
    // A code that is certificate data this app can't read yet (a
    // dictionary not downloaded, a newer layout) says so; anything else
    // may be an equipment label.
    const label = problem === 'not-a-certificate' ? readEquipmentLabelQr(code) : null;
    if (label) {
      const known = latestScan(label.id);
      if (known && isCalibrationDue(known.due) && !findStillOut(label.id)) {
        refuseDue(dueEquipmentMessage(known, 'taken out'));
        return {};
      }
      return { accepted: { label } };
    }
    if (problem === 'not-a-certificate') {
      setStatus('That code is neither a certificate QR code nor an equipment label (ID, Maker, Brand, Serial number).', true);
      return { rejected: 'Not a certificate or equipment label' };
    }
    setStatus(error, true);
    return { rejected: hint };
  },
  onResult: handleScannedEquipment,
});

// The camera closes first, so the pop-up isn't sitting on top of a live
// viewfinder.
function refuseDue(message) {
  setTimeout(() => {
    qrScanner.stop();
    setStatus(message, true);
    window.alert(message);
  }, 0);
}
document.querySelectorAll('#scanner [data-role="start"]').forEach((btn) => {
  btn.addEventListener('click', () => setStatus(''));
});

// `scanned` is { certificate } or { label }, as validate accepted it.
function handleScannedEquipment(scanned) {
  const { certificate, label } = scanned;
  const id = String(certificate ? certificate.id : label.id);
  const stillOut = findStillOut(id);
  if (stillOut) {
    returnEntry(stillOut.id);
  } else {
    // A certificate is saved like any other scan, so it's there for a
    // worksheet too — and takeOut picks the description up from it. A
    // label has nothing a worksheet could use, so it isn't.
    if (certificate) {
      addToHistory(certificate);
      renderEquipmentOptions();
    }
    if (takeOut(id, takenByInput.value.trim(), noteInput.value.trim(), label)) noteInput.value = '';
  }
  render();
}

// Equipment that's been scanned on this device is offered as
// suggestions when typing an ID instead — unless its calibration is
// due, when it couldn't be taken out anyway.
function renderEquipmentOptions() {
  equipmentOptions.innerHTML = '';
  const seen = new Set();
  loadHistory().forEach((h) => {
    if (!h.id || seen.has(h.id)) return;
    seen.add(h.id);
    if (isCalibrationDue(h.due)) return;
    const option = document.createElement('option');
    option.value = h.id;
    if (h.name) option.label = h.name;
    equipmentOptions.appendChild(option);
  });
}

// --- Taken by ---
// The names kept in Settings (the technician first), one press each;
// a name typed instead joins them once something is taken out under
// it. The name stays in the box from one scan to the next — a person
// usually takes several things — while the note is cleared each time.
function renderPeople() {
  const { technician, people } = loadSettings();
  const names = [];
  [technician.trim(), ...people].forEach((name) => {
    if (name && !names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
  });
  peoplePick.innerHTML = '';
  const current = takenByInput.value.trim().toLowerCase();
  names.forEach((name) => {
    const btn = el('button', 'people-pick-btn', name);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(name.toLowerCase() === current));
    btn.addEventListener('click', () => {
      takenByInput.value = name.toLowerCase() === takenByInput.value.trim().toLowerCase() ? '' : name;
      renderPeople();
    });
    peoplePick.appendChild(btn);
  });
}
takenByInput.addEventListener('input', renderPeople);

takeOutForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const equipmentText = equipmentInput.value.trim();
  if (!equipmentText) {
    setStatus('Enter the equipment ID first.', true);
    equipmentInput.focus();
    return;
  }
  if (!takeOut(equipmentText, takenByInput.value.trim(), noteInput.value.trim())) return;
  takeOutForm.reset();
  noteInput.value = '';
  render();
});

shareLogBtn.addEventListener('click', () => shareGroups(buildDayGroups(loadLabLog()), SHARE_TITLE));

clearLogBtn.addEventListener('click', () => {
  if (loadLabLog().length === 0) return;
  if (!window.confirm('Remove the whole in/out log from this device, including equipment that is still out?')) return;
  saveLabLogEntries([]);
  setStatus('');
  render();
});

// SHARE_LOG_KEY because sharing the log adds to it; SETTINGS_KEY for
// the names, the technician and how long out is too long.
hydrateStorage([LAB_LOG_KEY, HISTORY_KEY, SHARE_LOG_KEY, SETTINGS_KEY]).then(() => {
  renderPeople();
  renderEquipmentOptions();
  render();
});
