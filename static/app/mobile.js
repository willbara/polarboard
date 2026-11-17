import { $, el, mobile } from './core.js';
import { closeDrawer, openDrawer } from './panels.js';
import { noteMenu, rowMenu } from './tree.js';

// ------------------------------------------------------------------ phones and tablets

/**
 * iOS Safari keeps the page full height when the on-screen keyboard opens and simply
 * covers the bottom of it, formatting bar included. Size the app to the part that is
 * still visible instead. (Android resizes the page itself, thanks to
 * interactive-widget=resizes-content in the viewport tag, so nothing happens there.)
 */
const vv = window.visualViewport;
export function fitViewport() {
  if (!vv) return;
  const kb = mobile.matches && window.innerHeight - vv.height > 120;
  const root = document.documentElement.style;
  root.setProperty('--vvh', `${Math.round(vv.height)}px`);
  root.setProperty('--vvt', `${Math.round(vv.offsetTop)}px`);
  el.app.classList.toggle('kb-open', kb);
}
vv?.addEventListener('resize', fitViewport);
vv?.addEventListener('scroll', fitViewport);
fitViewport();

/** Swipe in from the left edge to open the sidebar, swipe it back to close it. */
let swipe = null;
document.addEventListener('touchstart', (e) => {
  if (!mobile.matches || e.touches.length !== 1 || el.layer.firstChild) return;
  const t = e.touches[0];
  const open = el.app.classList.contains('drawer-open');
  if (!open && t.clientX > 22) return;
  if (open && !e.target.closest('.side, .scrim')) return;
  swipe = { x: t.clientX, y: t.clientY, open, done: false };
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!swipe || swipe.done) return;
  const t = e.touches[0];
  const dx = t.clientX - swipe.x;
  const dy = t.clientY - swipe.y;
  if (Math.abs(dy) > 30 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; } // scrolling, not swiping
  if (!swipe.open && dx > 48) { swipe.done = true; openDrawer(); }
  if (swipe.open && dx < -48) { swipe.done = true; closeDrawer(); }
}, { passive: true });
document.addEventListener('touchend', () => { swipe = null; }, { passive: true });

/**
 * Press and hold to open an item's menu. iOS never sends contextmenu for a long press;
 * Android does, so whichever comes first wins and the other is dropped.
 */
export function longPress(box, selector, open) {
  let timer = 0;
  let start = null;
  let fired = false;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  box.addEventListener('touchstart', (e) => {
    const target = e.target.closest(selector);
    if (!target || e.touches.length > 1) return;
    const t = e.touches[0];
    fired = false;
    start = { x: t.clientX, y: t.clientY };
    timer = setTimeout(() => {
      fired = true;
      navigator.vibrate?.(8);
      open(target, { x: start.x, y: start.y });
    }, 480);
  }, { passive: true });
  box.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) cancel();
  }, { passive: true });
  box.addEventListener('touchend', (e) => {
    cancel();
    if (fired) { e.preventDefault(); fired = false; } // no click after the menu opened
  });
  box.addEventListener('touchcancel', cancel);
  box.addEventListener('contextmenu', (e) => {
    if (fired) { e.preventDefault(); e.stopPropagation(); return; }
    cancel();
  }, true);
}
longPress(el.tree, '.row', (row, at) => rowMenu(row, at));
longPress($('#starredList'), '[data-open]', (row, at) => noteMenu(row.dataset.open, at));
