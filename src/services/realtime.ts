import { invalidateSession } from './session';
import { setWriteListener, supabaseConfigured, TOKEN_STORAGE_KEY } from './supabase';

/**
 * Change notifications for the UI (useQuery / AuthProvider refresh when something changes):
 *   - right after this tab changes data, signs in or signs out;
 *   - when another tab of this browser does (via a localStorage "ping");
 *   - every 15 seconds while the page is visible, to pick up new orders and changes made elsewhere.
 * (Supabase Realtime is not used: it relies on Supabase Auth, and PrintFlow has its own sessions.)
 */

const PING_KEY = 'printflow:changed';
const POLL_MS = 15_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let poll: ReturnType<typeof setInterval> | null = null;

/** Several changes in a row are bundled into one refresh. */
function notify() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    invalidateSession();
    listeners.forEach((fn) => fn());
  }, 150);
}

/** Tell this tab and the other tabs of this browser that data changed. */
export function announceChange() {
  notify();
  try {
    localStorage.setItem(PING_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

setWriteListener(announceChange);

const onStorage = (e: StorageEvent) => {
  if (e.key === null || e.key === PING_KEY || e.key === TOKEN_STORAGE_KEY) notify();
};
const onVisible = () => {
  if (document.visibilityState === 'visible') notify();
};

function start() {
  if (!supabaseConfigured || poll) return;
  window.addEventListener('storage', onStorage);
  document.addEventListener('visibilitychange', onVisible);
  poll = setInterval(() => {
    if (document.visibilityState === 'visible') notify();
  }, POLL_MS);
}

function stop() {
  window.removeEventListener('storage', onStorage);
  document.removeEventListener('visibilitychange', onVisible);
  if (poll) clearInterval(poll);
  poll = null;
}

/** Calls `fn` whenever data may have changed, or the user signed in or out. Returns an unsubscribe function. */
export function onDbChange(fn: () => void): () => void {
  listeners.add(fn);
  start();
  return () => {
    listeners.delete(fn);
    if (!listeners.size) stop();
  };
}
