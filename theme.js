// theme.js — the look chosen on the Settings page, shared by every
// page. Two choices make it up, each kept in localStorage and each an
// attribute on <html> that style.css keys its variables off:
//   - the palette (data-palette): which of the themes below — what the
//     Settings page calls "Theme";
//   - the theme (data-theme): that palette's light half or its dark
//     half. The name is from when light and dark were all there was.
// Loaded from <head>, before <body>, and runs immediately (not on
// DOMContentLoaded) so both are set before anything paints — no flash
// of the wrong look. settings.js (settings.html only) calls setTheme()
// and setPalette() when the user picks an option; every other page
// just needs this script's immediate self-invocation below to stay in
// sync.

const THEME_KEY = 'certqr:theme';
const PALETTE_KEY = 'certqr:palette';

// The themes, in the order the Settings page offers them. Each one's
// colours are in style.css, under [data-palette="<id>"]. The first is
// the look the app had before there was a choice, and the one a phone
// that has never been asked gets.
const PALETTES = [
  { id: 'classic', name: 'Classic' },
  { id: 'claude', name: 'Claude' },
  { id: 'forest', name: 'Forest' },
  { id: 'ocean', name: 'Ocean' },
  { id: 'honey', name: 'Honey' },
  { id: 'cinema', name: 'Cinema' },
];

function getStoredTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

// Falls back to the OS/browser preference only until the user makes an
// explicit choice on the Settings page — after that, the stored choice
// always wins over prefers-color-scheme.
function getPreferredTheme() {
  const stored = getStoredTheme();
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

function setTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage full/unavailable — theme still applies below for this
    // session/tab, it just won't survive a reload.
  }
  applyTheme(theme);
}

// A stored id that isn't one of the palettes (there was none before, or
// it names one a later version dropped) is the first of them.
function getPreferredPalette() {
  let stored = null;
  try {
    stored = localStorage.getItem(PALETTE_KEY);
  } catch {
    stored = null;
  }
  return PALETTES.some((palette) => palette.id === stored) ? stored : PALETTES[0].id;
}

function applyPalette(palette) {
  document.documentElement.setAttribute('data-palette', palette);
}

function setPalette(palette) {
  try {
    localStorage.setItem(PALETTE_KEY, palette);
  } catch {
    // As in setTheme: applied for now, just not remembered.
  }
  applyPalette(palette);
}

applyTheme(getPreferredTheme());
applyPalette(getPreferredPalette());
