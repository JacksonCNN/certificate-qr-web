// reminders.js — reminders about equipment that's out of the lab and
// hasn't come back. Loaded on every page, after history.js. Off unless
// turned on in Settings (Lab Log → Remind me); the choice is this
// phone's own, like the permission to show notifications.
//
// When it's on:
//   - A round button floats over every page (not the Lab Log itself)
//     with how many are still out; pressing it opens the Lab Log.
//   - A notification at the chosen time of day lists what's still out:
//       - In the Android app with the notifications plugin (installed
//         from version 1.2.12 on), it's scheduled with the phone, so it
//         comes even when the app is closed. The next week of reminders
//         is set each time the app is opened or put away, from the log
//         as it stands then.
//       - Elsewhere (a browser, the iPhone web version on the Home
//         Screen), notifications can only be shown while the app is
//         open: the first time it's opened after that time of day, once
//         a day.
//       - An Android app installed before the plugin has the button
//         only.

const OUT_REMINDER_KEY = 'certqr:outReminder';
const OUT_REMINDER_DEFAULT_TIME = '17:00';
// The phone's notification ids for these, one per day ahead.
const OUT_REMINDER_FIRST_ID = 4100;
const OUT_REMINDER_DAYS = 7;

// { on, time: 'HH:MM', shownOn: 'YYYY-MM-DD' (the browser kind only) }.
function loadOutReminder() {
  try {
    const saved = JSON.parse(localStorage.getItem(OUT_REMINDER_KEY) || '{}');
    const time = /^\d{2}:\d{2}$/.test(saved.time || '') ? saved.time : OUT_REMINDER_DEFAULT_TIME;
    return { on: saved.on === true, time, shownOn: saved.shownOn || '' };
  } catch {
    return { on: false, time: OUT_REMINDER_DEFAULT_TIME, shownOn: '' };
  }
}

function saveOutReminder(reminder) {
  try {
    localStorage.setItem(OUT_REMINDER_KEY, JSON.stringify(reminder));
  } catch {
    // Not remembered; it goes back to off next time.
  }
}

// The phone's own notifications, when this copy of the Android app has them.
function nativeNotifications() {
  try {
    const cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
    if (cap.isPluginAvailable && !cap.isPluginAvailable('LocalNotifications')) return null;
    return (cap.Plugins && cap.Plugins.LocalNotifications) || null;
  } catch {
    return null;
  }
}

// What this phone can do: 'native', 'browser', 'button-only' (an
// Android app from before the plugin) or 'none'.
function outReminderSupport() {
  if (nativeNotifications()) return 'native';
  if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) return 'button-only';
  return typeof window.Notification === 'function' ? 'browser' : 'none';
}

// Asks to be allowed to show notifications. Resolves to true if it may.
async function askNotificationPermission() {
  const native = nativeNotifications();
  if (native) {
    let status = await native.checkPermissions();
    if (status.display === 'prompt' || status.display === 'prompt-with-rationale') status = await native.requestPermissions();
    return status.display === 'granted';
  }
  if (typeof window.Notification !== 'function') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

function equipmentStillOut() {
  return loadLabLog().filter((entry) => entry && !entry.inAt);
}

function outReminderText(out) {
  const title = out.length === 1 ? '1 piece of equipment is still out of the lab' : `${out.length} pieces of equipment are still out of the lab`;
  const lines = out.slice(0, 5).map((entry) => [entry.equipmentId, entry.takenBy && `taken by ${entry.takenBy}`].filter(Boolean).join(' — '));
  if (out.length > 5) lines.push(`and ${out.length - 5} more`);
  return { title, body: lines.join('\n') };
}

function reminderTimeOn(day, time) {
  const [hours, minutes] = time.split(':').map(Number);
  const at = new Date(day);
  at.setHours(hours, minutes, 0, 0);
  return at;
}

// Sets the phone's reminders for the coming week from the log as it is
// now — or clears them, when the reminder is off or nothing is out.
async function scheduleNativeOutReminders() {
  const native = nativeNotifications();
  if (!native) return;
  const reminder = loadOutReminder();
  const ids = Array.from({ length: OUT_REMINDER_DAYS }, (_, i) => ({ id: OUT_REMINDER_FIRST_ID + i }));
  try {
    await native.cancel({ notifications: ids });
    const out = equipmentStillOut();
    if (!reminder.on || out.length === 0) return;
    if ((await native.checkPermissions()).display !== 'granted') return;
    const { title, body } = outReminderText(out);
    const now = new Date();
    const notifications = [];
    for (let day = 0; notifications.length < OUT_REMINDER_DAYS && day <= OUT_REMINDER_DAYS; day += 1) {
      const date = new Date(now);
      date.setDate(now.getDate() + day);
      const at = reminderTimeOn(date, reminder.time);
      if (at <= now) continue;
      notifications.push({ id: OUT_REMINDER_FIRST_ID + notifications.length, title, body, largeBody: body, schedule: { at, allowWhileIdle: true } });
    }
    await native.schedule({ notifications });
  } catch {
    // Not set this time; tried again when the app is next opened.
  }
}

// The browser kind: once a day, on the first page opened after the time.
function showBrowserOutReminder() {
  if (typeof window.Notification !== 'function' || Notification.permission !== 'granted') return;
  const reminder = loadOutReminder();
  const now = new Date();
  const today = dayKey(now.toISOString());
  if (!reminder.on || reminder.shownOn === today || now < reminderTimeOn(now, reminder.time)) return;
  const out = equipmentStillOut();
  if (out.length === 0) return;
  saveOutReminder({ ...reminder, shownOn: today });
  try {
    const { title, body } = outReminderText(out);
    const note = new Notification(title, { body, tag: 'certqr-out' });
    note.onclick = () => {
      window.focus();
      window.location.href = 'lablog.html';
    };
  } catch {
    // Some browsers only show them from a service worker; the button still says it.
  }
}

// --- The floating button ---
const OUT_FAB_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
let outFab = null;

function renderOutFab() {
  const onLabLog = /lablog\.html$/.test(window.location.pathname);
  const out = loadOutReminder().on && !onLabLog ? equipmentStillOut() : [];
  if (out.length === 0) {
    if (outFab) outFab.classList.add('hidden');
    return;
  }
  if (!outFab) {
    outFab = document.createElement('a');
    outFab.className = 'out-fab';
    outFab.href = 'lablog.html';
    outFab.innerHTML = `${OUT_FAB_ICON}<span class="out-fab-count"></span>`;
    document.body.appendChild(outFab);
  }
  const label = out.length === 1 ? '1 still out of the lab' : `${out.length} still out of the lab`;
  outFab.title = label;
  outFab.setAttribute('aria-label', `${label} — open the Lab Log`);
  outFab.querySelector('.out-fab-count').textContent = out.length > 99 ? '99+' : String(out.length);
  outFab.classList.remove('hidden');
}

// Everything, from the log as it now stands. Settings calls this when
// the reminder is turned on or off, or its time changed.
async function refreshOutReminders() {
  const reminder = loadOutReminder();
  // Off, with nothing ever set: nothing to read or clear.
  if (!reminder.on && !nativeNotifications() && !outFab) return;
  if (!storageCache.has(LAB_LOG_KEY)) await hydrateStorage([LAB_LOG_KEY]);
  renderOutFab();
  showBrowserOutReminder();
  await scheduleNativeOutReminders();
}

document.addEventListener('DOMContentLoaded', () => {
  if (!loadOutReminder().on) return;
  refreshOutReminders();
  // Put away: set from what's out now (the Lab Log may have changed it).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') scheduleNativeOutReminders();
    else refreshOutReminders();
  });
});
