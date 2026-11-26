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

// --- Your signature ---
// Kept with your settings (history.js's loadSignature/saveSignature), so
// it follows you to another phone and is there with no connection. Drawn
// on the pad below, or taken from a photo of it on paper: either way kept
// as dark ink on a see-through background, cropped to the signature.
const signatureSaved = document.getElementById('signature-saved');
const signatureImage = document.getElementById('signature-image');
const signatureSavedAbout = document.getElementById('signature-saved-about');
const signatureEdit = document.getElementById('signature-edit');
const signaturePad = document.getElementById('signature-pad');
const signatureHint = document.getElementById('signature-hint');
const signatureSave = document.getElementById('signature-save');
const signatureClear = document.getElementById('signature-clear');
const signatureCancel = document.getElementById('signature-cancel');
const signatureFile = document.getElementById('signature-file');

const SIGNATURE_INK = [20, 24, 48];
const SIGNATURE_LINE_WIDTH = 2.6; // CSS px
const SIGNATURE_OUT_MAX = { width: 720, height: 240 };

// What's on the pad: strokes in CSS px, and a cleaned-up photo under them.
let padStrokes = [];
let padPhoto = null;
let padStroke = null;
let signatureEditing = false;

function padHasInk() {
  return padStrokes.length > 0 || Boolean(padPhoto);
}

function updatePadButtons() {
  signatureSave.disabled = !padHasInk();
  signatureHint.classList.toggle('hidden', padHasInk());
}

function drawStroke(ctx, stroke) {
  ctx.strokeStyle = `rgb(${SIGNATURE_INK.join(',')})`;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = SIGNATURE_LINE_WIDTH;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (stroke.length === 1) {
    ctx.beginPath();
    ctx.arc(stroke[0].x, stroke[0].y, SIGNATURE_LINE_WIDTH / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // Through the midpoints, so the line comes out smooth rather than jagged.
  ctx.beginPath();
  ctx.moveTo(stroke[0].x, stroke[0].y);
  for (let i = 1; i < stroke.length - 1; i += 1) {
    const mid = { x: (stroke[i].x + stroke[i + 1].x) / 2, y: (stroke[i].y + stroke[i + 1].y) / 2 };
    ctx.quadraticCurveTo(stroke[i].x, stroke[i].y, mid.x, mid.y);
  }
  const last = stroke[stroke.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

function redrawPad() {
  const ctx = signaturePad.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, signaturePad.width, signaturePad.height);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = signaturePad.width / ratio;
  const height = signaturePad.height / ratio;
  if (padPhoto) {
    // Fitted inside the pad, with a little room round it.
    const scale = Math.min((width - 16) / padPhoto.width, (height - 16) / padPhoto.height, 1);
    const w = padPhoto.width * scale;
    const h = padPhoto.height * scale;
    ctx.drawImage(padPhoto, (width - w) / 2, (height - h) / 2, w, h);
  }
  padStrokes.forEach((stroke) => drawStroke(ctx, stroke));
}

// The canvas's pixels follow its size on screen (and the screen's
// sharpness): set when the pad is shown and when the phone is turned.
function sizePad() {
  if (!signatureEditing) return;
  const ratio = window.devicePixelRatio || 1;
  const rect = signaturePad.getBoundingClientRect();
  if (!rect.width) return;
  const width = Math.round(rect.width * ratio);
  const height = Math.round(rect.height * ratio);
  if (signaturePad.width !== width || signaturePad.height !== height) {
    signaturePad.width = width;
    signaturePad.height = height;
  }
  redrawPad();
}

function clearPad() {
  padStrokes = [];
  padPhoto = null;
  padStroke = null;
  redrawPad();
  updatePadButtons();
}

function padPoint(event) {
  const rect = signaturePad.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

signaturePad.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 && event.pointerType === 'mouse') return;
  event.preventDefault();
  signaturePad.setPointerCapture(event.pointerId);
  padStroke = [padPoint(event)];
  padStrokes.push(padStroke);
  redrawPad();
  updatePadButtons();
});

signaturePad.addEventListener('pointermove', (event) => {
  if (!padStroke) return;
  event.preventDefault();
  const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
  (events.length ? events : [event]).forEach((e) => padStroke.push(padPoint(e)));
  redrawPad();
});

['pointerup', 'pointercancel', 'lostpointercapture'].forEach((type) => {
  signaturePad.addEventListener(type, () => { padStroke = null; });
});

// A photo of a signature on paper → the ink alone: the paper's
// brightness is taken from the photo itself (its brighter part), and
// anything near it becomes see-through, so a grey, shadowed sheet still
// comes out clean.
async function signatureFromPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('That picture couldn\'t be opened.'));
      image.src = url;
    });
    const scale = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    const levels = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 4) {
      levels[Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2])] += 1;
    }
    // The paper: the brightness 70% of the picture is darker than.
    let count = 0;
    let paper = 255;
    const total = px.length / 4;
    for (let level = 0; level < 256; level += 1) {
      count += levels[level];
      if (count >= total * 0.7) { paper = level; break; }
    }
    if (paper < 60) throw new Error('That picture is too dark — try one of the signature on white paper.');
    const clear = paper * 0.82;
    const solid = paper * 0.45;
    let inked = 0;
    for (let i = 0; i < px.length; i += 4) {
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      const alpha = Math.max(0, Math.min(1, (clear - lum) / (clear - solid)));
      [px[i], px[i + 1], px[i + 2]] = SIGNATURE_INK;
      px[i + 3] = Math.round(alpha * 255);
      if (alpha > 0.5) inked += 1;
    }
    if (inked < 30) throw new Error('No signature found in that picture.');
    ctx.putImageData(data, 0, 0);
    return trimToInk(canvas, 6) || canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// The part of `canvas` with ink on it, plus `pad` pixels round it; null
// when there's no ink.
function trimToInk(canvas, pad) {
  const { width, height } = canvas;
  const px = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (px[(y * width + x) * 4 + 3] > 16) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        bottom = y;
      }
    }
  }
  if (right < 0) return null;
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  right = Math.min(width - 1, right + pad);
  bottom = Math.min(height - 1, bottom + pad);
  const out = document.createElement('canvas');
  out.width = right - left + 1;
  out.height = bottom - top + 1;
  out.getContext('2d').drawImage(canvas, left, top, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

// What's on the pad, cropped and no bigger than SIGNATURE_OUT_MAX, as a PNG.
function padToSignatureImage() {
  const trimmed = trimToInk(signaturePad, Math.round(6 * (window.devicePixelRatio || 1)));
  if (!trimmed) return null;
  const scale = Math.min(1, SIGNATURE_OUT_MAX.width / trimmed.width, SIGNATURE_OUT_MAX.height / trimmed.height);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(trimmed.width * scale));
  out.height = Math.max(1, Math.round(trimmed.height * scale));
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(trimmed, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

function openSignatureEdit() {
  signatureEditing = true;
  signatureSaved.classList.add('hidden');
  signatureEdit.classList.remove('hidden');
  signatureCancel.classList.toggle('hidden', !loadSignature());
  clearPad();
  sizePad();
}

function renderSignature() {
  const signature = loadSignature();
  if (signatureEditing && signature) return;
  if (!signature) {
    if (!signatureEditing) openSignatureEdit();
    signatureCancel.classList.add('hidden');
    return;
  }
  signatureEdit.classList.add('hidden');
  signatureSaved.classList.remove('hidden');
  signatureImage.src = signature.image;
  signatureSavedAbout.textContent = signature.savedAt ? `Saved ${formatSavedAt(signature.savedAt)}.` : '';
}

signatureSave.addEventListener('click', () => {
  try {
    const image = padToSignatureImage();
    if (!image) {
      showProfileNote('Sign on the pad first.', true);
      return;
    }
    saveSignature(image);
    signatureEditing = false;
    clearPad();
    renderSignature();
    showProfileNote('Signature saved.');
  } catch (err) {
    showProfileNote(err.message || String(err), true);
  }
});

signatureClear.addEventListener('click', clearPad);

signatureCancel.addEventListener('click', () => {
  signatureEditing = false;
  clearPad();
  renderSignature();
});

document.getElementById('signature-change').addEventListener('click', () => {
  showProfileNote('');
  openSignatureEdit();
});

document.getElementById('signature-remove').addEventListener('click', () => {
  if (!window.confirm('Remove your signature?')) return;
  saveSignature(null);
  showProfileNote('Signature removed.');
  renderSignature();
});

document.getElementById('signature-upload').addEventListener('click', () => signatureFile.click());

signatureFile.addEventListener('change', async () => {
  const file = signatureFile.files && signatureFile.files[0];
  signatureFile.value = '';
  if (!file) return;
  try {
    padPhoto = await signatureFromPhoto(file);
    padStrokes = [];
    redrawPad();
    updatePadButtons();
    showProfileNote('');
  } catch (err) {
    showProfileNote(err.message || String(err), true);
  }
});

window.addEventListener('resize', sizePad);

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
hydrateStorage([SETTINGS_KEY]).then(renderSignature);
// The name and admin as the server has them now.
if (loadServerConfig() && !loadServerConfig().signedOut) {
  refreshServerAccount().then(renderProfile).catch(() => {});
}
