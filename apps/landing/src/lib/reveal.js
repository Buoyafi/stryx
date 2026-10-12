/** Content rises into place from underneath as it scrolls into view. */

/** Every block that rises, as one selector so the markup stays free of animation attributes. */
export const RISE_TARGETS = [
  '.section-head > *',
  '.steps > *',
  '.bento > *',
  '.chain-grid',
  '.card-grid > *',
  '.faq-list > *',
  '.drops-strip',
  '.join > *',
  '.stage .console',
  '.stage .float',
].join(', ');

/** Staggered delay for the nth sibling, capped so a long row never makes anyone wait. */
export function staggerDelay(index, stepMs = 90, max = 7) {
  return Math.min(Math.max(index, 0), max) * stepMs;
}

/** True when an element has already been scrolled past (nothing left of it on screen). */
export function isAbove(rect) {
  return rect.bottom < 0;
}

export function mountScrollReveal(selector = RISE_TARGETS) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion || typeof IntersectionObserver === 'undefined') return;

  const targets = Array.from(document.querySelectorAll(selector));
  const seen = new Map();
  targets.forEach((el) => {
    el.setAttribute('data-rise', '');
    const n = seen.get(el.parentElement) ?? 0;
    seen.set(el.parentElement, n + 1);
    el.style.setProperty('--d', `${staggerDelay(n)}ms`);
  });

  document.documentElement.classList.add('rise-armed');

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting || isAbove(entry.boundingClientRect)) {
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.1, rootMargin: '0px 0px -6% 0px' },
  );
  targets.forEach((el) => observer.observe(el));
}
