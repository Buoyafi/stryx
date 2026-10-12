/** Whether the landing page links to its Terms and Privacy pages. */
export function legalLinksOn(env = {}) {
  return env.VITE_LEGAL_LINKS === 'true' || (env.DEV === true && env.VITE_LEGAL_LINKS !== 'false');
}

export function mountLegalLinks(on, root = document) {
  if (!on) return;
  root.querySelectorAll('[data-legal]').forEach((el) => {
    el.hidden = false;
  });
}
