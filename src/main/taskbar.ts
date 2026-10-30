import { BrowserWindow, app, nativeImage } from 'electron';
import { DONE_BADGE_PNG } from './taskbar-badge';

/**
 * The app's taskbar (Dock) button: a spinning progress while some chat is working, and a green check when an answer
 * finished while the window wasn't in front — it goes away as soon as the window is opened.
 */
let win: BrowserWindow | null = null;
let busy = false;
let done = false;
const badge = nativeImage.createFromDataURL(`data:image/png;base64,${DONE_BADGE_PNG}`);

export function attachTaskbar(w: BrowserWindow) {
  win = w;
  w.on('focus', () => {
    if (!done) return;
    done = false;
    paint();
  });
  w.on('closed', () => (win = null));
  paint();
}

/** Called on every chat status change; `finished` — an answer just ended. */
export function chatsChanged(anyBusy: boolean, finished: boolean) {
  busy = anyBusy;
  // the user is looking at the window: no check needed
  if (finished && win && !(win.isFocused() && !win.isMinimized())) done = true;
  paint();
}

function paint() {
  if (!win || win.isDestroyed()) return;
  win.setProgressBar(busy ? 2 : -1, { mode: busy ? 'indeterminate' : 'none' });
  if (process.platform === 'win32') win.setOverlayIcon(done ? badge : null, done ? 'Есть готовый ответ' : '');
  else if (process.platform === 'darwin') app.dock?.setBadge(done ? '✓' : '');
}
