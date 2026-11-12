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
