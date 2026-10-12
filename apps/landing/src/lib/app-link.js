/** Links from the landing page into the app (the dashboard), for visitors who already have an invite. */

const DEV_APP_URL = 'http://localhost:5173';

/** A usable app address from the build environment, or null. https anywhere; http only on localhost. */
export function resolveAppUrl(env = {}) {
  const raw = String(env.VITE_APP_URL ?? '').trim();
  if (!raw) return env.DEV === true ? DEV_APP_URL : null;
  try {
    const url = new URL(raw);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) return url.href;
  } catch {
    // not a URL: treated as not configured
  }
  return null;
}

/** Points every `[data-app-link]` at the app and reveals it (and its `[data-app-only]` wrapper). */
export function mountAppLinks(url, root = document) {
  if (!url) return;
  root.querySelectorAll('[data-app-link]').forEach((a) => {
    a.setAttribute('href', url);
    a.hidden = false;
  });
  root.querySelectorAll('[data-app-only]').forEach((el) => {
    el.hidden = false;
  });
}
