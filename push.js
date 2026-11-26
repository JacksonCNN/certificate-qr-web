// push.js — notifications from the shared server when someone else takes
// equipment out of the lab or brings it back (the Lab Log). Loaded on
// every page, after history.js and reminders.js. server/push.mjs sends
// them, so they arrive within seconds, even with the app closed. Two
// ways, whichever this copy of the app is:
//   - the Android app: Firebase Cloud Messaging. Only an app built with
//     Firebase (android/app/google-services.json) — the CertQRApp plugin
//     (AppInfoPlugin.java) says whether it was. An app installed before
//     1.2.22 doesn't have the push plugin at all, and needs the new app
//     installed.
//   - the web version (an iPhone's Home Screen, or a browser): Web Push,
//     shown by its service worker (web/sw.js). On an iPhone only once the
//     app is on the Home Screen and opened from there (iOS 16.4 or later).
//
// Each person turns them on for themselves, on each phone they want them
// on (Settings → "Notify me when equipment goes out or comes back"); the
// choice is kept per account on this phone (certqr:labNotify, among
// ACCOUNT_LOCAL_STORAGE). Turned on, this phone's address — the FCM
// token, or the Web Push subscription — goes to the server for the
// account signed in; turned off, or another account on the phone that
// hasn't turned them on, it's taken back.

const LAB_NOTIFY_KEY = 'certqr:labNotify';
// This phone's address and which account it was last sent for:
// { token (FCM token, or the Web Push endpoint), key (the server key a Web
//   Push subscription was made with), registeredFor: '<url>|<user id>', sentAt }.
const PUSH_DEVICE_KEY = 'certqr:pushDevice';
const PUSH_CHANNEL_ID = 'equipment';
// Sent again now and then, in case the server lost it.
const PUSH_RESEND_MS = 3 * 24 * 60 * 60 * 1000;
const PUSH_TOKEN_TIMEOUT_MS = 20000;

function isLabNotifyOn() {
  try {
    return localStorage.getItem(LAB_NOTIFY_KEY) === '1';
  } catch {
    return false;
  }
}

function setLabNotifyOn(on) {
  try {
    if (on) localStorage.setItem(LAB_NOTIFY_KEY, '1');
    else localStorage.removeItem(LAB_NOTIFY_KEY);
  } catch {
    // Not remembered on this phone.
  }
}

function loadPushDevice() {
  try {
    const saved = JSON.parse(localStorage.getItem(PUSH_DEVICE_KEY) || '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

function savePushDevice(device) {
  try {
    localStorage.setItem(PUSH_DEVICE_KEY, JSON.stringify(device));
  } catch {
    // Sent again next time.
  }
}

function isNativeShell() {
  const cap = window.Capacitor;
  return Boolean(cap && cap.isNativePlatform && cap.isNativePlatform());
}

function nativePlugin(name) {
  try {
    const cap = window.Capacitor;
    if (!isNativeShell()) return null;
    if (cap.isPluginAvailable && !cap.isPluginAvailable(name)) return null;
    return (cap.Plugins && cap.Plugins[name]) || (cap.registerPlugin ? cap.registerPlugin(name) : null);
  } catch {
    return null;
  }
}

function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isHomeScreenApp() {
  return navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
}

// What this copy of the app can do:
//   'ready'       the Android app, with Firebase
//   'web'         the web version, with Web Push
//   'home-screen' the web version on an iPhone, opened in Safari: it has
//                 to be added to the Home Screen first
//   'old-ios'     an iPhone too old for it (before iOS 16.4)
//   'no-firebase' the Android app, built without Firebase
//   'old-app'     the Android app, installed before notifications came in
//   'not-supported'
let labNotifySupportPromise = null;
function labNotifySupport() {
  if (labNotifySupportPromise) return labNotifySupportPromise;
  labNotifySupportPromise = (async () => {
    if (isNativeShell()) {
      if (!nativePlugin('PushNotifications') || !nativePlugin('CertQRApp')) return 'old-app';
      try {
        const info = await nativePlugin('CertQRApp').info();
        return info && info.pushReady ? 'ready' : 'no-firebase';
      } catch {
        return 'old-app';
      }
    }
    const canPush = 'serviceWorker' in navigator && 'PushManager' in window && typeof window.Notification === 'function';
    if (isIos() && !isHomeScreenApp()) return 'home-screen';
    if (!canPush) return isIos() ? 'old-ios' : 'not-supported';
    // The web version's service worker (web-app.js starts it); a copy run
    // from the dev server has none.
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      return registration ? 'web' : 'not-supported';
    } catch {
      return 'not-supported';
    }
  })();
  return labNotifySupportPromise;
}

function accountKey(config) {
  return `${config.url}|${config.userId}`;
}

// --- The Android app: Firebase ---
let pushListenersAdded = false;
let tokenWaiters = [];

function addPushListeners() {
  if (pushListenersAdded) return;
  pushListenersAdded = true;
  const push = nativePlugin('PushNotifications');
  push.addListener('registration', ({ value }) => {
    const waiters = tokenWaiters;
    tokenWaiters = [];
    waiters.forEach((w) => w.resolve(value));
  });
  push.addListener('registrationError', ({ error }) => {
    const waiters = tokenWaiters;
    tokenWaiters = [];
    waiters.forEach((w) => w.reject(new Error(`This phone couldn't sign up for notifications: ${error}`)));
  });
  // Tapped: open the Lab Log.
  push.addListener('pushNotificationActionPerformed', ({ notification }) => {
    openPushPage(notification && notification.data);
  });
  // With the app open, Android doesn't show it by itself: shown here.
  push.addListener('pushNotificationReceived', (notification) => {
    const local = nativePlugin('LocalNotifications');
    if (!local) return;
    local.schedule({
      notifications: [{
        id: Math.floor(Math.random() * 1e9) + 10000,
        title: notification.title || 'Lab Log',
        body: notification.body || '',
        largeBody: notification.body || '',
        channelId: PUSH_CHANNEL_ID,
        extra: notification.data || {},
      }],
    }).catch(() => {});
  });
  const local = nativePlugin('LocalNotifications');
  if (local) {
    local.addListener('localNotificationActionPerformed', ({ notification }) => {
      openPushPage(notification && notification.extra);
    });
  }
}

function openPushPage(data) {
  if (!data || data.page !== 'lablog.html') return;
  if (/lablog\.html$/.test(window.location.pathname)) window.location.reload();
  else window.location.href = 'lablog.html';
}

function fcmToken() {
  const push = nativePlugin('PushNotifications');
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    tokenWaiters.push(waiter);
    setTimeout(() => {
      tokenWaiters = tokenWaiters.filter((w) => w !== waiter);
      reject(new Error('This phone didn\'t get a notification token in time. Check the connection and try again.'));
    }, PUSH_TOKEN_TIMEOUT_MS);
    push.register().catch((err) => {
      tokenWaiters = tokenWaiters.filter((w) => w !== waiter);
      reject(err);
    });
  });
}

async function makePushChannel() {
  try {
    await nativePlugin('PushNotifications').createChannel({
      id: PUSH_CHANNEL_ID,
      name: 'Equipment in and out',
      description: 'When someone takes equipment out of the lab or brings it back',
      importance: 4,
      visibility: 1,
      vibration: true,
    });
  } catch {
    // Android's default channel is used instead.
  }
}

async function fcmPermissionGranted(ask) {
  const push = nativePlugin('PushNotifications');
  let status = await push.checkPermissions();
  if (ask && (status.receive === 'prompt' || status.receive === 'prompt-with-rationale')) status = await push.requestPermissions();
  return status.receive === 'granted';
}

// --- The web version: Web Push ---
function keyBytes(base64url) {
  const text = atob(base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4));
  return Uint8Array.from(text, (ch) => ch.charCodeAt(0));
}

function sameKey(buffer, base64url) {
  if (!buffer) return false;
  const a = new Uint8Array(buffer);
  const b = keyBytes(base64url);
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

// This browser's subscription, made with the server's key (a new one if
// it was made with another).
async function webSubscription(serverKey) {
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options && subscription.options.applicationServerKey, serverKey)) {
    await subscription.unsubscribe().catch(() => {});
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(serverKey) });
  }
  return subscription;
}

// Asked for straight from the tap on the switch: Safari only asks when it
// comes from one. Settings calls this before anything else, and hands the
// answer to turnOnLabNotify.
function askWebNotifyPermission() {
  if (typeof window.Notification !== 'function') return Promise.resolve('denied');
  if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
  try {
    return Promise.resolve(Notification.requestPermission());
  } catch {
    return new Promise((resolve) => Notification.requestPermission(resolve));
  }
}

async function serverPushStatus() {
  try {
    return await serverAccountRequest('GET', 'me/push');
  } catch (err) {
    if (/Not found/i.test(err.message)) throw new Error('The shared server needs updating before it can send notifications.');
    throw err;
  }
}

// --- Turning it on and off (Settings) ---
const LAB_NOTIFY_UNSUPPORTED = {
  'home-screen': 'On an iPhone, add the app to the Home Screen first (Share → Add to Home Screen), then open it from there and turn this on.',
  'old-ios': 'This iPhone needs iOS 16.4 or later for notifications.',
  'not-supported': 'Notifications aren\'t supported here. Use the Android app, or the web version added to an iPhone\'s Home Screen.',
  'old-app': 'Install the latest Android app (from the newest release) to get these notifications.',
  'no-firebase': 'This copy of the app was built without Firebase, so it can\'t get these notifications yet (see server/README.md).',
};

// Resolves once the server has it; rejects with a message fit to show.
// `permission`: for the web version, askWebNotifyPermission()'s promise.
async function turnOnLabNotify({ permission } = {}) {
  const support = await labNotifySupport();
  if (support !== 'ready' && support !== 'web') throw new Error(LAB_NOTIFY_UNSUPPORTED[support]);
  const config = loadServerConfig();
  if (!config || config.signedOut) throw new Error('Sign in to the shared server first.');

  if (support === 'web') {
    const answer = await (permission || askWebNotifyPermission());
    if (answer !== 'granted') {
      throw new Error(isIos()
        ? 'Notifications are blocked for this app. Allow them in the iPhone\'s Settings → Notifications → Certificate QR.'
        : 'Notifications are blocked for this site. Allow them in the browser\'s site settings.');
    }
    const status = await serverPushStatus();
    if (!status || !status.webAvailable || !status.webPublicKey) throw new Error('The shared server can\'t send notifications to the web version yet; it may need updating.');
    const subscription = await webSubscription(status.webPublicKey);
    await serverAccountRequest('PUT', 'me/push', { subscription: subscription.toJSON() });
    savePushDevice({ token: subscription.endpoint, key: status.webPublicKey, registeredFor: accountKey(config), sentAt: new Date().toISOString() });
    setLabNotifyOn(true);
    return;
  }

  const status = await serverPushStatus();
  if (!status || !status.available) throw new Error('Notifications to the Android app aren\'t set up on the shared server yet (Firebase, see server/README.md).');
  if (!(await fcmPermissionGranted(true))) throw new Error('Notifications are blocked for this app. Allow them in the phone\'s settings (Apps → Certificate QR → Notifications).');
  addPushListeners();
  await makePushChannel();
  const token = await fcmToken();
  await serverAccountRequest('PUT', 'me/push', { token });
  savePushDevice({ token, registeredFor: accountKey(config), sentAt: new Date().toISOString() });
  setLabNotifyOn(true);
}

async function forgetPushDevice(device) {
  const web = (await labNotifySupport()) === 'web';
  await serverAccountRequest('DELETE', 'me/push', web ? { endpoint: device.token } : { token: device.token });
  savePushDevice({ token: device.token, key: device.key });
}

async function turnOffLabNotify() {
  setLabNotifyOn(false);
  const device = loadPushDevice();
  if (device.token) await forgetPushDevice(device);
}

// --- On every page ---
// Keeps the server's list right for whoever is signed in now: sends this
// phone's address if it's on and the server hasn't had it (or not for a
// while, or it's changed), takes it back if it's off but was sent for
// someone.
async function syncLabNotify() {
  const support = await labNotifySupport();
  if (support !== 'ready' && support !== 'web') return;
  if (support === 'ready') addPushListeners();
  const config = loadServerConfig();
  if (!config || config.signedOut || navigator.onLine === false) return;
  const device = loadPushDevice();
  try {
    if (!isLabNotifyOn()) {
      // Another account had it on, or it was turned off with no connection.
      if (device.token && device.registeredFor) await forgetPushDevice(device);
      return;
    }
    let token;
    let subscription = null;
    let key = device.key;
    const fresh = device.sentAt && Date.now() - new Date(device.sentAt).getTime() < PUSH_RESEND_MS;
    if (support === 'web') {
      if (Notification.permission !== 'granted') return;
      // Asked again now and then, in case the server's key was changed.
      if (!key || !fresh) key = (await serverPushStatus()).webPublicKey;
      if (!key) return;
      subscription = await webSubscription(key);
      token = subscription.endpoint;
    } else {
      if (!(await fcmPermissionGranted(false))) return;
      token = await fcmToken();
    }
    if (token === device.token && device.registeredFor === accountKey(config) && fresh) return;
    await serverAccountRequest('PUT', 'me/push', subscription ? { subscription: subscription.toJSON() } : { token });
    savePushDevice({ token, key, registeredFor: accountKey(config), sentAt: new Date().toISOString() });
  } catch {
    // Tried again on the next page.
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // In the Android app, a notification tapped while the app was closed is
  // handed over as soon as these listeners are added, whichever page
  // opens first.
  labNotifySupport().then((support) => {
    if (support === 'ready') addPushListeners();
    if (support === 'ready' || support === 'web') syncLabNotify();
  });
});
