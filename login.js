// login.js — the login page. Every other page sends the app here when
// nobody is signed in, when the server signed this phone out, or when
// the password is due again (login-gate.js). Like a browser's account
// chooser: the accounts that have signed in on this phone are listed,
// and each signs in again — or is switched to — with its password. A new
// one signs in with a login ID and password, or by scanning a QR (an
// admin's invite, or a sign-in QR from the person's other phone).
//
// The work is history.js's (signInToAccount, acceptServerInvite,
// acceptServerTransfer, signOutAccount, removeSavedAccount); the list
// of accounts is kept on this phone only.
//
// The address says why the page is open:
//   ?reason=signin | locked | expired | switch | add | signout
//   &account=<scope>  — one account, its password asked
//   &next=<page>      — where to go once signed in

const params = new URLSearchParams(location.search);
const reason = params.get('reason') || '';

const titleEl = document.getElementById('login-title');
const subtitleEl = document.getElementById('login-subtitle');
const noteEl = document.getElementById('login-note');
const chooseView = document.getElementById('login-choose');
const accountsList = document.getElementById('login-accounts');
const addBtn = document.getElementById('login-add');
const unlockForm = document.getElementById('login-unlock');
const whoBtn = document.getElementById('login-who');
const whoAvatar = document.getElementById('login-who-avatar');
const whoName = document.getElementById('login-who-name');
const whoMeta = document.getElementById('login-who-meta');
const unlockPassword = document.getElementById('login-unlock-password');
const unlockRemember = document.getElementById('login-unlock-remember');
const unlockSubmit = document.getElementById('login-unlock-submit');
const newView = document.getElementById('login-new');
const loginForm = document.getElementById('login-form');
const serverSummary = document.getElementById('login-server-summary');
const serverHost = document.getElementById('login-server-host');
const serverChange = document.getElementById('login-server-change');
const serverRow = document.getElementById('login-server-row');
const serverInput = document.getElementById('login-server');
const idInput = document.getElementById('login-id');
const passwordInput = document.getElementById('login-password');
const rememberInput = document.getElementById('login-remember');
const submitBtn = document.getElementById('login-submit');
const firstHint = document.getElementById('login-first-hint');
const backBtn = document.getElementById('login-back');
const inviteForm = document.getElementById('login-invite');
const inviteText = document.getElementById('login-invite-text');
const invitePassword = document.getElementById('login-invite-password');
const inviteRepeat = document.getElementById('login-invite-repeat');
const inviteRemember = document.getElementById('login-invite-remember');
const inviteSubmit = document.getElementById('login-invite-submit');
const inviteCancel = document.getElementById('login-invite-cancel');

// The account whose password is being asked, and the invite waiting for
// a password to be chosen.
let chosen = null;
let pendingInvite = null;
let busy = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// The account's initials in its own colour (sidebar.js).
function paintAvatar(node, account) {
  node.textContent = accountInitials(account.userName);
  node.style.background = accountAvatarColour(account.scope);
}

function showNote(text, kind) {
  noteEl.textContent = text || '';
  noteEl.classList.toggle('hidden', !text);
  noteEl.classList.toggle('login-note-error', kind === 'error');
}

// Where to go once signed in: a page of this app, never somewhere else.
function nextPage() {
  const next = params.get('next') || '';
  return /^[a-z0-9-]+\.html([?#].*)?$/i.test(next) && !/^login\.html/i.test(next) ? next : 'index.html';
}

function goOn() {
  location.replace(nextPage());
}

// Whether the account signed in now can carry on with no password: not
// signed out by the server, and "Remember me" (or still the same visit).
function activeIsOpen() {
  const config = loadServerConfig();
  if (!config || config.signedOut) return false;
  if (config.remember !== false) return true;
  try {
    return sessionStorage.getItem(SESSION_KEY) === accountScope(config);
  } catch {
    return false;
  }
}

function setBusy(on, button, label) {
  busy = on;
  [unlockSubmit, submitBtn, inviteSubmit, addBtn].forEach((btn) => {
    btn.disabled = on;
  });
  if (button) button.textContent = label;
}

// --- Views ---
function showView(name) {
  chooseView.classList.toggle('hidden', name !== 'choose');
  unlockForm.classList.toggle('hidden', name !== 'unlock');
  newView.classList.toggle('hidden', name !== 'new');
  inviteForm.classList.toggle('hidden', name !== 'invite');
  if (name !== 'new') loginScanner.stop();
}

function showChooser() {
  const accounts = listSavedAccounts();
  if (accounts.length === 0) {
    showNew();
    return;
  }
  chosen = null;
  titleEl.textContent = 'Choose an account';
  subtitleEl.textContent = 'Accounts that have signed in on this phone';
  renderAccounts(accounts);
  showView('choose');
}

function renderAccounts(accounts) {
  accountsList.innerHTML = '';
  accounts.forEach((account) => {
    const item = el('li', 'login-account');
    const btn = el('button', 'login-row-btn');
    btn.type = 'button';
    const avatar = el('span', 'login-avatar');
    avatar.setAttribute('aria-hidden', 'true');
    paintAvatar(avatar, account);
    btn.appendChild(avatar);
    const text = el('span', 'login-who-text');
    text.appendChild(el('span', 'login-who-name', account.userName));
    text.appendChild(el('span', 'login-who-meta', `${account.userId} · ${hostOf(account.url)}`));
    btn.appendChild(text);
    if (account.active) {
      const open = activeIsOpen();
      btn.appendChild(el('span', `login-badge${open ? '' : ' login-badge-muted'}`, open ? 'Signed in' : 'Locked'));
    } else if (account.signedOut) {
      btn.appendChild(el('span', 'login-badge login-badge-muted', 'Signed out'));
    }
    btn.addEventListener('click', () => chooseAccount(account));
    item.appendChild(btn);

    const remove = el('button', 'login-remove');
    remove.type = 'button';
    remove.title = `Remove ${account.userName} from this phone`;
    remove.setAttribute('aria-label', remove.title);
    remove.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
    remove.addEventListener('click', () => removeAccount(account));
    item.appendChild(remove);
    accountsList.appendChild(item);
  });
}

// The one signed in, still open: straight back to the app. Anyone else:
// their password.
function chooseAccount(account) {
  if (busy) return;
  if (account.active && activeIsOpen()) {
    goOn();
    return;
  }
  showUnlock(account);
}

function showUnlock(account, note) {
  chosen = account;
  titleEl.textContent = account.active ? 'Welcome back' : 'Switch account';
  subtitleEl.textContent = 'Enter your password to continue';
  paintAvatar(whoAvatar, account);
  whoName.textContent = account.userName;
  whoMeta.textContent = `${account.userId} · ${hostOf(account.url)}`;
  unlockForm.reset();
  unlockRemember.checked = account.remember;
  showNote(note || '', note && /signed out/i.test(note) ? 'error' : '');
  showView('unlock');
  unlockPassword.focus();
}

function showNew() {
  chosen = null;
  titleEl.textContent = 'Sign in';
  subtitleEl.textContent = 'Sign in to your team\'s shared server';
  const accounts = listSavedAccounts();
  backBtn.classList.toggle('hidden', accounts.length === 0);
  // Nobody has signed in here yet: what the phone holds goes to the first.
  firstHint.classList.toggle('hidden', accounts.length > 0);
  const known = accounts[0] && accounts[0].url;
  if (known && !serverInput.value) serverInput.value = known;
  renderServerField(Boolean(known));
  showView('new');
}

// A server already known is a line with "Change"; otherwise the box.
function renderServerField(collapsed) {
  serverSummary.classList.toggle('hidden', !collapsed);
  serverRow.classList.toggle('hidden', collapsed);
  serverHost.textContent = hostOf(serverInput.value);
}

serverChange.addEventListener('click', () => {
  renderServerField(false);
  serverInput.focus();
});

addBtn.addEventListener('click', () => {
  showNote('');
  showNew();
  idInput.focus();
});
whoBtn.addEventListener('click', () => {
  showNote('');
  showChooser();
});
backBtn.addEventListener('click', () => {
  showNote('');
  showChooser();
});

// --- Signing in ---
async function signIn(url, id, password, remember, button) {
  if (busy) return;
  const label = button.textContent;
  setBusy(true, button, 'Signing in…');
  showNote('');
  try {
    const { offline } = await signInToAccount(url, id, password, { remember });
    if (offline) showNote('Signed in with no connection. Changes are sent once the server can be reached.');
    goOn();
  } catch (err) {
    showNote(err.message || String(err), 'error');
    setBusy(false, button, label);
  }
}

unlockForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!chosen) return;
  signIn(chosen.url, chosen.userId, unlockPassword.value, unlockRemember.checked, unlockSubmit);
});

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  // An invite link pasted in (one sent by message to the phone that has
  // to scan it).
  const pasted = parseServerInvite(serverInput.value) || parseServerInvite(idInput.value);
  if (pasted) {
    if (parseServerInvite(serverInput.value)) serverInput.value = pasted.url;
    else idInput.value = '';
    useQr(pasted);
    return;
  }
  if (!serverInput.value.trim()) {
    renderServerField(false);
    showNote('Enter the server address, or scan a QR to sign in.', 'error');
    serverInput.focus();
    return;
  }
  signIn(serverInput.value, idInput.value, passwordInput.value, rememberInput.checked, submitBtn);
});

// --- Scanning a QR ---
// A sign-in QR from this person's other phone signs in straight away; an
// invite asks for a password to be chosen.
async function useQr(qr) {
  if (qr.transfer) {
    if (busy) return;
    setBusy(true, submitBtn, 'Signing in…');
    showNote('Signing in…');
    try {
      await acceptServerTransfer(qr, { remember: rememberInput.checked });
      goOn();
    } catch (err) {
      showNote(err.message || String(err), 'error');
      setBusy(false, submitBtn, 'Sign in');
    }
    return;
  }
  pendingInvite = qr;
  titleEl.textContent = 'Join';
  subtitleEl.textContent = 'Choose your password';
  inviteText.textContent = `Invite to ${hostOf(qr.url)} for login ID "${qr.id}".`;
  inviteForm.reset();
  inviteRemember.checked = true;
  showNote('');
  showView('invite');
  invitePassword.focus();
}

const loginScanner = createQrScanner({
  root: document.getElementById('login-scanner'),
  validate(code) {
    const qr = parseServerInvite(code && code.data);
    if (qr) return { accepted: qr };
    return { rejected: 'Not a sign-in QR. Ask your admin for an invite, or make a sign-in QR on your other phone (Profile → Sign in another phone).' };
  },
  onResult: useQr,
});

inviteCancel.addEventListener('click', () => {
  pendingInvite = null;
  showNote('');
  showNew();
});

inviteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!pendingInvite || busy) return;
  if (invitePassword.value !== inviteRepeat.value) {
    showNote('The two passwords aren\'t the same.', 'error');
    return;
  }
  setBusy(true, inviteSubmit, 'Joining…');
  showNote('');
  try {
    await acceptServerInvite(pendingInvite, invitePassword.value, { remember: inviteRemember.checked });
    pendingInvite = null;
    goOn();
  } catch (err) {
    showNote(err.message || String(err), 'error');
    setBusy(false, inviteSubmit, 'Join');
  }
});

// --- Removing an account from this phone ---
async function removeAccount(account) {
  if (busy) return;
  const unsent = await countAccountUnsent(account.scope);
  const waiting = [];
  if (unsent.changes > 0) waiting.push(`${unsent.changes === 1 ? '1 part of the app has' : `${unsent.changes} parts of the app have`} changes not sent to the server yet`);
  if (unsent.photos > 0) waiting.push(`${unsent.photos === 1 ? '1 photo hasn\'t' : `${unsent.photos} photos haven't`} been sent yet`);
  const warning = waiting.length > 0 ? `\n\nWarning: ${waiting.join(', and ')}. They will be lost.` : '';
  const signedIn = account.active ? ' It is signed in now, and will be signed out.' : '';
  if (!window.confirm(`Remove ${account.userName} (${account.userId}) from this phone?\n\nIts data on this phone is deleted.${signedIn} Everything on the server stays, and it can sign in here again.${warning}`)) return;
  setBusy(true);
  try {
    await removeSavedAccount(account.scope);
    showNote(`${account.userName} has been removed from this phone.`);
  } catch (err) {
    showNote(err.message || String(err), 'error');
  } finally {
    setBusy(false);
  }
  showChooser();
}

// --- Opening ---
async function start() {
  document.getElementById('login-foot').textContent = typeof APP_VERSION === 'string' ? `Version ${APP_VERSION}` : '';
  if (reason === 'signout') {
    const config = loadServerConfig();
    setBusy(true);
    showNote('Signing out…');
    try {
      await signOutAccount();
      showNote(config ? `${config.userName || config.userId} has signed out. Their data stays on this phone for when they sign in again.` : '');
    } catch (err) {
      showNote(err.message || String(err), 'error');
    } finally {
      setBusy(false);
    }
    // Reloaded or gone back to, the page shouldn't sign out again.
    history.replaceState(null, '', 'login.html?reason=switch');
    showChooser();
    return;
  }
  const accounts = listSavedAccounts();
  const wanted = params.get('account') && accounts.find((a) => a.scope === params.get('account'));
  const active = accounts.find((a) => a.active);
  if (wanted) {
    chooseAccount(wanted);
  } else if (reason === 'add') {
    showNew();
  } else if ((reason === 'locked' || reason === 'expired') && active) {
    showUnlock(active, reason === 'expired' ? 'The server has signed this phone out (the password was changed, or the account turned off). Sign in again. Changes made here are kept and sent once you do.' : '');
  } else {
    showChooser();
  }
}

start();
