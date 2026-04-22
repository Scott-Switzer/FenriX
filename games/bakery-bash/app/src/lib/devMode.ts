/**
 * Dev-mode opt-in helpers.
 *
 * The DevNav (phase jumper, route links, etc.) is useful for the dev team
 * and for the professor running a game — but we don't want the 30-50 college
 * students playing a live session to see it. So instead of the old
 * `import.meta.env.PROD` check (which hid it in production but showed it to
 * everyone during dev/preview builds), we gate visibility behind an explicit
 * opt-in that persists in localStorage.
 *
 * How to enable:
 *   1. Visit the app with `?dev=1` in the URL (from anywhere). The flag is
 *      stored in localStorage and the nav becomes visible on every page.
 *   2. Or click the "Show dev tools" button on the Professor page.
 *
 * How to disable:
 *   1. Visit any URL with `?dev=0`.
 *   2. Or click "Hide dev tools" on the Professor page.
 *
 * Students never type either URL and never see the Professor page, so they
 * never see the nav.
 */

const STORAGE_KEY = "bakery-bash:dev-mode";

export function isDevModeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setDevMode(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (enabled) {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    window.dispatchEvent(new Event("bakery-bash:dev-mode-change"));
  } catch {
    /* noop — ignore quota/private-mode errors */
  }
}

/**
 * Reads `?dev=1` / `?dev=0` from the current URL and mirrors it to localStorage.
 * Safe to call on every render; idempotent when the URL param matches the flag.
 * Returns the resulting enabled state so callers can react without re-reading.
 */
export function syncDevModeFromUrl(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const dev = params.get("dev");
    if (dev === "1" && !isDevModeEnabled()) {
      setDevMode(true);
    } else if (dev === "0" && isDevModeEnabled()) {
      setDevMode(false);
    }
  } catch {
    /* noop */
  }
  return isDevModeEnabled();
}
