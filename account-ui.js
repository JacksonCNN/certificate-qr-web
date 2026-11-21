// account-ui.js — small pieces of the account screens, shared by the
// Settings page (signing in, an admin's invites) and the Profile page
// (password, another phone). Loaded after history.js; plain globals.

// `text` as a QR code's SVG (vendor/qrcode-generator.js): black on
// white with a quiet zone, whatever the theme, so any camera reads it.
function qrSvg(text, alt) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true, alt });
}

// --- Show / hide a password ---
// An eye at the end of each password box shows what's been typed, and
// hides it again. Emptying the form hides it too.
const EYE_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_SHUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><line x1="3" y1="3" x2="21" y2="21"/></svg>';

function addPasswordEye(input) {
  const field = document.createElement('span');
  field.className = 'password-field';
  input.parentNode.insertBefore(field, input);
  field.appendChild(input);
  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'password-eye';
  function show(visible) {
    input.type = visible ? 'text' : 'password';
    eye.innerHTML = visible ? EYE_SHUT : EYE_OPEN;
    eye.setAttribute('aria-pressed', String(visible));
    eye.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    eye.title = visible ? 'Hide password' : 'Show password';
  }
  // Keeps the keyboard where it was on a phone.
  eye.addEventListener('mousedown', (event) => event.preventDefault());
  eye.addEventListener('click', () => show(input.type === 'password'));
  if (input.form) input.form.addEventListener('reset', () => show(false));
  show(false);
  field.appendChild(eye);
}

document.querySelectorAll('input[type="password"]').forEach(addPasswordEye);
