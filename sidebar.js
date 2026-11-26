// sidebar.js — collapsible sidebar, shared by every page. Same
// before-first-paint pattern as theme.js: reads the saved collapsed
// state and stamps it on <html> immediately (not on DOMContentLoaded),
// so the sidebar never visibly snaps from expanded to collapsed (or
// back) after the page has already painted.

const SIDEBAR_COLLAPSED_KEY = 'certqr:sidebarCollapsed';

function getSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function applySidebarCollapsed(collapsed) {
  document.documentElement.toggleAttribute('data-sidebar-collapsed', collapsed);
}

function setSidebarCollapsed(collapsed) {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Storage full/unavailable — still applies for this session/tab,
    // it just won't be remembered on the next page load.
  }
  applySidebarCollapsed(collapsed);
}

applySidebarCollapsed(getSidebarCollapsed());

// The toggle button itself lives in <body>, which doesn't exist yet
// when this script runs (it's loaded from <head>) — wire it up once
// the DOM is ready.
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('sidebar-toggle');
  if (!toggle) return;

  function syncToggleLabel(collapsed) {
    const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
  }

  syncToggleLabel(getSidebarCollapsed());
  toggle.addEventListener('click', () => {
    const next = !getSidebarCollapsed();
    setSidebarCollapsed(next);
    syncToggleLabel(next);
  });
});

// The phone's bottom bar has room for four pages; the rest are in a
// menu that the bar's "More" button opens above it. Closed again by
// choosing a page (which leaves this one), by a press anywhere else,
// or by Esc.
document.addEventListener('DOMContentLoaded', () => {
  const moreBtn = document.getElementById('bottom-more-btn');
  const moreMenu = document.getElementById('bottom-more-menu');
  if (!moreBtn || !moreMenu) return;

  function setMoreOpen(open) {
    moreMenu.classList.toggle('hidden', !open);
    moreBtn.setAttribute('aria-expanded', String(open));
  }

  moreBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    setMoreOpen(moreMenu.classList.contains('hidden'));
  });
  document.addEventListener('click', (event) => {
    if (!moreMenu.contains(event.target)) setMoreOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setMoreOpen(false);
  });
});

// A page's or a section's explanation (class "info-text") is hidden
// behind an (i) beside its title: the page's h1, or the section's h2.
// Pressing it shows the explanation, and again hides it.
const INFO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="11"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.info-text').forEach((text, index) => {
    const header = text.closest('.page-header');
    const section = text.closest('section');
    const heading = header ? header.querySelector('h1') : section && section.querySelector('.result-header h2');
    if (!heading) {
      text.classList.remove('hidden');
      return;
    }
    if (!text.id) text.id = `info-text-${index}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'info-btn';
    btn.title = 'What is this?';
    btn.setAttribute('aria-label', `About ${heading.textContent.trim()}`);
    btn.setAttribute('aria-controls', text.id);
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = INFO_ICON;
    btn.addEventListener('click', () => {
      const open = text.classList.toggle('hidden') === false;
      btn.setAttribute('aria-expanded', String(open));
    });
    heading.appendChild(btn);
  });
});

// Links for admins only (the Server Dashboard): shown when this device
// is signed in to a shared server as an admin. The server checks too —
// the link is only a way there.
function showAdminLinks() {
  let admin = false;
  try {
    const config = JSON.parse(localStorage.getItem('certqr:server') || 'null');
    admin = Boolean(config && config.admin && !config.signedOut);
  } catch {
    admin = false;
  }
  document.querySelectorAll('.admin-only').forEach((link) => link.classList.toggle('hidden', !admin));
}
document.addEventListener('DOMContentLoaded', showAdminLinks);
window.addEventListener('certqr:server-account', showAdminLinks);
window.addEventListener('certqr:server-status', showAdminLinks);

// --- The account menu ---
// The signed-in account's avatar at the top right of every page, like a
// browser's: who's signed in, the other accounts that have signed in on
// this phone (switching to one asks for its password, on the login
// page), adding another, and signing out. Read straight from storage
// (history.js isn't loaded yet when this runs); the login page does the
// work. accountInitials and accountAvatarColour are the login page's too.
const ACCOUNT_AVATAR_COLOURS = ['#0088b0', '#1a7f4b', '#aa0b56', '#6a4bb7', '#8a5a00', '#2f6f8f', '#b4451f'];

// "Ahmad bin Ali" → "AA"; "jackson" → "J".
function accountInitials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return `${words[0][0]}${words.length > 1 ? words[words.length - 1][0] : ''}`.toUpperCase();
}

// Each account keeps one colour, so it's known at a glance.
function accountAvatarColour(scope) {
  let hash = 0;
  for (let i = 0; i < scope.length; i += 1) hash = (hash * 31 + scope.charCodeAt(i)) >>> 0;
  return ACCOUNT_AVATAR_COLOURS[hash % ACCOUNT_AVATAR_COLOURS.length];
}

function accountAvatar(name, scope, className) {
  const avatar = document.createElement('span');
  avatar.className = className || 'login-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = accountInitials(name);
  avatar.style.background = accountAvatarColour(scope);
  return avatar;
}

function accountHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function readAccountMenuState() {
  let config = null;
  let accounts = [];
  try {
    config = JSON.parse(localStorage.getItem('certqr:server') || 'null');
    accounts = JSON.parse(localStorage.getItem('certqr:accounts') || '[]');
  } catch {
    // Shown with what could be read.
  }
  if (!config || typeof config.url !== 'string') return null;
  const scope = `${config.url}|${config.userId || ''}`;
  const others = (Array.isArray(accounts) ? accounts : [])
    .filter((a) => a && typeof a.scope === 'string' && a.scope !== scope)
    .sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
  return { config, scope, name: config.userName || config.userId || '', others };
}

const ACCOUNT_MENU_ICONS = {
  add: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3.1-6 7-6s7 2 7 6"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="16" y1="11" x2="22" y2="11"/></svg>',
  profile: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/></svg>',
  signout: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
};

document.addEventListener('DOMContentLoaded', () => {
  const header = document.querySelector('.page-header');
  if (!header || window.CERTQR_LOCKED === true) return;
  const here = (location.pathname.split('/').pop() || 'index.html') + location.search + location.hash;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'account-menu-btn';
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'account-menu hidden';
  menu.setAttribute('role', 'menu');
  header.appendChild(button);
  header.appendChild(menu);

  function link(href, content, className) {
    const a = document.createElement('a');
    a.href = href;
    a.setAttribute('role', 'menuitem');
    if (className) a.className = className;
    content.forEach((part) => a.appendChild(part));
    return a;
  }

  function icon(name) {
    const span = document.createElement('span');
    span.className = 'account-menu-icon';
    span.innerHTML = ACCOUNT_MENU_ICONS[name];
    return span;
  }

  function text(value, className) {
    const span = document.createElement('span');
    if (className) span.className = className;
    span.textContent = value;
    return span;
  }

  function renderButton() {
    const state = readAccountMenuState();
    button.classList.toggle('hidden', !state);
    if (!state) return;
    button.textContent = accountInitials(state.name);
    button.style.background = accountAvatarColour(state.scope);
    const label = `Account: ${state.name}`;
    button.title = label;
    button.setAttribute('aria-label', label);
  }

  function renderMenu() {
    const state = readAccountMenuState();
    menu.innerHTML = '';
    if (!state) return;
    const current = document.createElement('div');
    current.className = 'account-menu-current';
    current.appendChild(accountAvatar(state.name, state.scope));
    current.appendChild(text(state.name, 'login-who-name'));
    current.appendChild(text(`${state.config.userId} · ${accountHost(state.config.url)}`, 'login-who-meta'));
    menu.appendChild(current);
    menu.appendChild(link('profile.html', [icon('profile'), text('Manage your account')]));

    if (state.others.length > 0) {
      menu.appendChild(text('Switch account', 'account-menu-heading'));
      state.others.forEach((account) => {
        const params = new URLSearchParams({ reason: 'switch', account: account.scope, next: here });
        const words = document.createElement('span');
        words.className = 'login-who-text';
        words.appendChild(text(account.userName || account.userId, 'login-who-name'));
        words.appendChild(text(`${account.userId} · ${accountHost(account.url)}`, 'login-who-meta'));
        menu.appendChild(link(`login.html?${params.toString()}`, [accountAvatar(account.userName || account.userId, account.scope), words]));
      });
    }
    menu.appendChild(link(`login.html?${new URLSearchParams({ reason: 'add', next: here }).toString()}`, [icon('add'), text('Add another account')]));
    const divider = document.createElement('div');
    divider.className = 'account-menu-divider';
    menu.appendChild(divider);
    const signOut = link('login.html?reason=signout', [icon('signout'), text('Sign out')], 'account-menu-signout');
    signOut.addEventListener('click', (event) => {
      if (!window.confirm(`Sign ${state.name} out of this phone?\n\nTheir data stays on this phone, and anything not sent yet goes when they sign in again. Signing in again needs the password.`)) event.preventDefault();
    });
    menu.appendChild(signOut);
  }

  function setOpen(open) {
    if (open) renderMenu();
    menu.classList.toggle('hidden', !open);
    button.setAttribute('aria-expanded', String(open));
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    setOpen(menu.classList.contains('hidden'));
  });
  document.addEventListener('click', (event) => {
    if (!menu.contains(event.target)) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });
  window.addEventListener('certqr:server-account', renderButton);
  renderButton();
});
