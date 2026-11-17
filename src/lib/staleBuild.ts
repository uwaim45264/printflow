/**
 * After a new deploy, a tab opened earlier still points at the old build's file names, so loading a part of the
 * app on demand (e.g. the PDF tools when printing) fails with "Failed to fetch dynamically imported module".
 * The fix is to reload the page once to get the new build.
 */

const KEY = 'printflow:reloaded-for-update';

export const isStaleBuildError = (err: unknown) =>
  /dynamically imported module|importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(
    String((err as Error)?.message ?? err),
  );

/** Reloads the page once (not again within a minute, so a real outage cannot cause a reload loop). Returns false if it did not reload. */
export function reloadForUpdate(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* storage unavailable: still reload once */
  }
  window.location.reload();
  return true;
}

export function installStaleBuildReload() {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadForUpdate()) event.preventDefault();
  });
}
