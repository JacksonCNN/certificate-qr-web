// web-app.js — only in the web version of the app (the one opened in
// Safari on an iPhone, with nothing installed); scripts/build-web.mjs
// adds it to the end of every page. The Android app never has it: it
// updates through updater.js instead.
//
// It does three things:
//   1. Starts the service worker (sw.js), which keeps the whole app on
//      the phone so it opens and works with no connection. Only the QR
//      dictionaries and the update check use the network.
//   2. Asks for the app's data to be kept: Safari may otherwise clear a
//      website's stored data when it hasn't been opened for a while.
//      (Added to the Home Screen it is kept regardless.)
//   3. Updates, the way the Android app does: when a newer release has
//      been published, it is downloaded in the background and a box asks
//      to "Update now" — or "Later", and then it is used the next time
//      the app is opened fresh. Settings → "Check for updates" checks
//      and says so there instead. It reuses updater.js's box.
//
// A build that differs only in its QR dictionaries isn't asked about:
// sw.js fetches dictionaries from the network first anyway.

(function webApp() {
  if (!('serviceWorker' in navigator)) return;
  if (typeof isNativeApp === 'function' && isNativeApp()) return;

  const PUT_OFF_KEY = 'certqr:webUpdatePutOff';
  const CHECK_EVERY_MS = 30 * 60 * 1000;
  // A page that started under an older service worker reloads when a
  // newer one takes over (after "Update now", here or in another tab),
  // so it isn't left running files that are no longer kept. The very
  // first install also takes over, and there's nothing to reload for.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let registration = null;
  let lastCheck = Date.now();
  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // The version that is published now, or null with no connection.
  async function publishedVersion() {
    try {
      const res = await fetch('web-version.json', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      return res.ok ? (await res.json()).version || null : null;
    } catch {
      return null;
    }
  }

  // A newer build downloaded and waiting to take over, if there is one.
  function waitingWorker() {
    return registration && registration.waiting && navigator.serviceWorker.controller ? registration.waiting : null;
  }

  // Whatever is still downloading, finished (or given up on).
  function settled(reg) {
    const worker = reg.installing;
    if (!worker) return Promise.resolve();
    return new Promise((resolve) => {
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' || worker.state === 'activated' || worker.state === 'redundant') resolve();
      });
    });
  }

  // A newer release, downloaded: its version, or null if there isn't one.
  async function readyUpdate() {
    if (!waitingWorker()) return null;
    const version = await publishedVersion();
    return version && compareVersions(version, APP_VERSION) > 0 ? version : null;
  }

  function applyUpdate() {
    const worker = registration && registration.waiting;
    if (!worker) {
      window.location.reload();
      return;
    }
    if (typeof renderUpdateDialog === 'function') renderUpdateDialog({ title: 'Updating…', message: 'Restarting into the new version…', buttons: [] });
    worker.postMessage({ type: 'skip-waiting' });
  }

  // The box, as the Android app shows it — but not on Settings, which
  // says so in its own update section.
  async function offerUpdate() {
    if (document.getElementById('check-update-btn')) {
      showSettingsResult();
      return;
    }
    if (typeof renderUpdateDialog !== 'function' || updateDialog) return;
    const version = await readyUpdate();
    if (!version) return;
    try {
      if (sessionStorage.getItem(PUT_OFF_KEY) === version) return;
    } catch {
      // Without it the box may come back sooner; nothing else is lost.
    }
    renderUpdateDialog({
      title: 'Update ready',
      message: `Version ${version} of the app has been downloaded (this has v${APP_VERSION}). Update now to use it.`,
      buttons: [
        { label: 'Update now', primary: true, onClick: applyUpdate },
        {
          label: 'Later',
          onClick: () => {
            try {
              sessionStorage.setItem(PUT_OFF_KEY, version);
            } catch {
              // As above.
            }
            closeUpdateDialog();
          },
        },
      ],
    });
  }

  // Asks the server for a newer build, at most every half hour unless
  // `now`. Resolves once it has been downloaded, or found not to exist.
  async function checkNow(now) {
    if (!registration || navigator.onLine === false) return;
    if (!now && Date.now() - lastCheck < CHECK_EVERY_MS) return;
    lastCheck = Date.now();
    await registration.update();
    await settled(registration);
  }

  // --- Settings → Updates ---
  // settings.js's own check is the Android app's (a GitHub token this
  // version doesn't carry), so its two buttons are taken over here.
  let settingsCheckBtn = null;
  let settingsRestartBtn = null;

  function takeOverSettings() {
    const checkBtn = document.getElementById('check-update-btn');
    const restartBtn = document.getElementById('update-restart-btn');
    if (!checkBtn || !restartBtn) return;
    settingsCheckBtn = checkBtn.cloneNode(true);
    checkBtn.replaceWith(settingsCheckBtn);
    settingsRestartBtn = restartBtn.cloneNode(true);
    restartBtn.replaceWith(settingsRestartBtn);
    settingsRestartBtn.classList.add('hidden');
    settingsRestartBtn.textContent = 'Update now';
    settingsRestartBtn.addEventListener('click', applyUpdate);
    settingsCheckBtn.addEventListener('click', () => settingsCheck());
    settingsCheck();
  }

  async function showSettingsResult() {
    if (!settingsRestartBtn) return;
    const version = await readyUpdate();
    settingsRestartBtn.classList.toggle('hidden', !version);
    if (version) showUpdateBanner('aware', '🔔', `Version ${version} has been downloaded (you have v${APP_VERSION}). Update now, or it will be used the next time the app is opened.`);
    else showUpdateBanner('safe', '✓', `You're on the latest version (v${APP_VERSION}).`);
  }

  async function settingsCheck() {
    if (!registration) {
      showUpdateNote('This browser is not keeping the app for offline use, so it cannot update itself — reload the page to get the newest version.');
      return;
    }
    const label = settingsCheckBtn.textContent;
    settingsCheckBtn.disabled = true;
    settingsCheckBtn.textContent = 'Checking…';
    showUpdateNote('Checking for updates…');
    try {
      await checkNow(true);
      await showSettingsResult();
    } catch (err) {
      showUpdateNote(`Couldn't check for updates — you may be offline. The app keeps working without a connection. (${(err && err.message) || err})`);
    } finally {
      settingsCheckBtn.disabled = false;
      settingsCheckBtn.textContent = label;
    }
  }

  // --- Start ---
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      registration = reg;
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed') offerUpdate();
        });
      });
      takeOverSettings();
      if (reg.waiting) offerUpdate();
    }).catch(() => {
      // Not kept for offline use (a private window, say); it still runs.
      takeOverSettings();
    });
  });

  // Coming back to the app after a while counts as opening it.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkNow(false).catch(() => {});
  });
}());
