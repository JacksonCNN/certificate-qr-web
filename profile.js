// profile.js — the Profile page: who this phone is signed in to the
// shared server as, and what they can do about it — change their name
// or password, sign another phone in with a QR, switch account or sign
// out. Signing in, switching and signing out happen on the login page
// (login.js). The work itself is history.js's
// (changeServerName, changeServerPassword, createServerTransfer,
// and the login page's signOutAccount).

const profileNone = document.getElementById('profile-none');
const profileSignedIn = document.getElementById('profile-signed-in');
const profileAvatar = document.getElementById('profile-avatar');
const profileName = document.getElementById('profile-name');
const profileMeta = document.getElementById('profile-meta');
const profileStatus = document.getElementById('profile-status');
const profileSignedOutActions = document.getElementById('profile-signed-out-actions');
const profileNamePanel = document.getElementById('profile-name-panel');
const profileNameForm = document.getElementById('profile-name-form');
const profileNameInput = document.getElementById('profile-name-input');
const profileNameSave = document.getElementById('profile-name-save');
const profileTransferOpen = document.getElementById('profile-transfer-open');
const profileTransferBox = document.getElementById('profile-transfer-box');
const profileTransferQr = document.getElementById('profile-transfer-qr');
const profileTransferAbout = document.getElementById('profile-transfer-about');
const profileTransferClose = document.getElementById('profile-transfer-close');
const profilePasswordOpen = document.getElementById('profile-password-open');
const profilePasswordForm = document.getElementById('profile-password-form');
const profilePasswordCurrent = document.getElementById('profile-password-current');
const profilePasswordNew = document.getElementById('profile-password-new');
const profilePasswordRepeat = document.getElementById('profile-password-repeat');
const profilePasswordCancel = document.getElementById('profile-password-cancel');
const profileSignOut = document.getElementById('profile-sign-out');
const profileNote = document.getElementById('profile-note');

function showProfileNote(text, isError) {
  profileNote.textContent = text;
  profileNote.classList.toggle('hidden', !text);
  profileNote.classList.toggle('scan-status-error', Boolean(isError));
}

// "Ahmad bin Ali" → "AA"; "jackson" → "J".
function profileInitials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : '';
  return `${first}${last}`.toUpperCase();
}

function profileStatusText(config) {
  let host = config.url;
  try {
    host = new URL(config.url).host;
  } catch {
    // Shown as it is.
  }
  if (config.signedOut) return `Signed out of ${host}. Changes made on this phone are kept here until you sign in again.`;
  const status = getServerStatus();
  if (status.state === 'offline') return `${host} can't be reached right now. Working from this phone's copy.`;
  if (status.pending > 0) return `${host}: changes waiting to be sent.`;
  return `${host}: up to date${status.lastSyncAt ? ` (synced ${formatTime(status.lastSyncAt)})` : ''}.`;
}

function renderProfile() {
  const config = loadServerConfig();
  profileNone.classList.toggle('hidden', Boolean(config));
  profileSignedIn.classList.toggle('hidden', !config);
  if (!config) return;
  const signedOut = Boolean(config.signedOut);
  const name = config.userName || config.userId;
  profileAvatar.textContent = profileInitials(name);
  profileName.textContent = name;
  profileMeta.textContent = `Login ID: ${config.userId}${config.admin ? ' · Admin' : ''}`;
  profileStatus.textContent = profileStatusText(config);
  profileSignedOutActions.classList.toggle('hidden', !signedOut);
  // Signed out, the server can't be asked to change anything.
  profileNamePanel.classList.toggle('hidden', signedOut);
  profileTransferOpen.classList.toggle('hidden', signedOut);
  profilePasswordOpen.classList.toggle('hidden', signedOut);
  if (signedOut) {
    closeProfileTransfer();
    closeProfilePasswordForm();
  }
  if (document.activeElement !== profileNameInput) profileNameInput.value = name;
}

window.addEventListener('certqr:server-status', renderProfile);
window.addEventListener('certqr:server-account', renderProfile);

// --- Your name ---
profileNameForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  profileNameSave.disabled = true;
  try {
    const config = await changeServerName(profileNameInput.value);
    profileNameInput.blur();
    showProfileNote(`Your name is now ${config.userName}.`);
  } catch (err) {
    showProfileNote(err.message || String(err), true);
  } finally {
    profileNameSave.disabled = false;
    renderProfile();
  }
});

// --- Another phone ---
// A one-time QR that signs another phone in as this person, so a new
// phone needn't have the address, login ID and password typed in.
function closeProfileTransfer() {
  profileTransferQr.innerHTML = '';
  profileTransferBox.classList.add('hidden');
}

profileTransferOpen.addEventListener('click', async () => {
  profileTransferOpen.disabled = true;
  showProfileNote('');
  closeProfilePasswordForm();
  try {
    const { link, expiresAt } = await createServerTransfer();
    const config = loadServerConfig();
    const name = (config && (config.userName || config.userId)) || 'you';
    profileTransferQr.innerHTML = qrSvg(link, 'Sign-in QR for another phone');
    profileTransferAbout.textContent = `On the other phone, open the app and tap Scan QR to sign in (if someone is signed in there: their avatar at the top right → Add another account). It signs in as ${name}, no password needed. Works once, until ${formatSavedAt(expiresAt)}. Show it only to your own phone.`;
    profileTransferBox.classList.remove('hidden');
    profileTransferBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    showProfileNote(err.message || String(err), true);
  } finally {
    profileTransferOpen.disabled = false;
  }
});

profileTransferClose.addEventListener('click', closeProfileTransfer);

// --- Password ---
function closeProfilePasswordForm() {
  profilePasswordForm.reset();
  profilePasswordForm.classList.add('hidden');
}

profilePasswordOpen.addEventListener('click', () => {
  closeProfileTransfer();
  profilePasswordForm.classList.toggle('hidden');
  if (!profilePasswordForm.classList.contains('hidden')) profilePasswordCurrent.focus();
});

profilePasswordCancel.addEventListener('click', closeProfilePasswordForm);

profilePasswordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (profilePasswordNew.value !== profilePasswordRepeat.value) {
    showProfileNote('The two new passwords aren\'t the same.', true);
    return;
  }
  try {
    await changeServerPassword(profilePasswordCurrent.value, profilePasswordNew.value);
    closeProfilePasswordForm();
    showProfileNote('Password changed. Your other phones have been signed out and need the new password.');
  } catch (err) {
    showProfileNote(err.message || String(err), true);
  }
});

// --- Switching account ---
// The accounts that have signed in on this phone, on the login page; the
// other one's password is asked there.
document.getElementById('profile-switch').addEventListener('click', () => {
  location.href = 'login.html?reason=switch&next=profile.html';
});

// --- Signing out ---
// Done on the login page (signOutAccount): the account and its data stay
// on this phone, put aside until its password brings them back, and
// anything not sent yet waits with them. Other accounts can sign in
// meanwhile.
profileSignOut.addEventListener('click', async () => {
  profileSignOut.disabled = true;
  await flushServerQueue();
  const unsent = await countUnsentServerChanges();
  profileSignOut.disabled = false;
  const warning = unsent > 0 ? `\n\n${unsent === 1 ? '1 part of the app has' : `${unsent} parts of the app have`} changes the server hasn't received yet. They wait on this phone, and go when you sign in again.` : '';
  if (!window.confirm(`Sign out of this phone?\n\nYour data stays here for when you sign in again with your password.${warning}`)) return;
  location.href = 'login.html?reason=signout';
});

renderProfile();
// The name and admin as the server has them now.
if (loadServerConfig() && !loadServerConfig().signedOut) {
  refreshServerAccount().then(renderProfile).catch(() => {});
}
