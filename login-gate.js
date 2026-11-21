// login-gate.js — loaded first in <head> on every page but the login
// page. Sends the app to the login page (login.html) when nobody is
// signed in on this phone, when the server has signed this phone out,
// or when the account was signed into without "Remember me" and the app
// has been closed since (sessionStorage lasts as long as the app stays
// open). The page itself doesn't start meanwhile: history.js sees
// CERTQR_LOCKED and loads nothing.
//
// The same reading of storage as history.js (loadServerConfig,
// accountScope), written out here so it runs before anything else.

(function loginGate() {
  let config = null;
  try {
    config = JSON.parse(localStorage.getItem('certqr:server') || 'null');
  } catch {
    config = null;
  }
  const signedIn = config && typeof config.url === 'string' && typeof config.token === 'string';
  let reason = '';
  if (!signedIn) {
    reason = 'signin';
  } else if (config.signedOut) {
    reason = 'expired';
  } else if (config.remember === false) {
    let session = null;
    try {
      session = sessionStorage.getItem('certqr:session');
    } catch {
      session = null;
    }
    if (session !== `${config.url}|${config.userId || ''}`) reason = 'locked';
  }
  if (!reason) return;
  window.CERTQR_LOCKED = true;
  document.documentElement.style.visibility = 'hidden';
  const page = (location.pathname.split('/').pop() || 'index.html') + location.search + location.hash;
  location.replace(`login.html?${new URLSearchParams({ reason, next: page }).toString()}`);
})();
