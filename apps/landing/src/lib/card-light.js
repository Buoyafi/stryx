/** Cards glow where the pointer is: sets --mx / --my (the pointer's position inside the card) for the CSS in styles.css. */
export function mountCardLight(selector = '.card') {
  if (!window.matchMedia('(hover: hover)').matches) return;
  document.querySelectorAll(selector).forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    }, { passive: true });
  });
}
