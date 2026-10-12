/** Thin, null-safe wrappers over the globals from /brand/theme.js (a classic script). */
export function toggleTheme(): void {
  window.toggleStryxTheme?.();
}

/** Replays the logo animation. Call on a successful mint; theme.js already calls it on theme switch. */
export function chargeLogo(): void {
  window.chargeLogo?.();
}

/**
 * Plays the "charged" animation (electrons speed up, orbits tilt, bolt zaps) on ONE element, using the
 * same brand.css classes chargeLogo() uses.
 */
export function chargeElement(el: Element | null | undefined, ms = 800): void {
  if (!el) return;
  el.classList.remove('is-charged');
  void (el as HTMLElement).offsetWidth; // restart the animation
  el.classList.add('is-charged');
  setTimeout(() => el.classList.remove('is-charged'), ms);
}
