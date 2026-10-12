/** The phone menu (a <details>). */
export function mountNavMenu(menu, doc = document) {
  if (!menu) return;
  const close = () => menu.removeAttribute('open');
  menu.querySelectorAll('.nav-menu__panel a').forEach((a) => a.addEventListener('click', close));
  doc.addEventListener('click', (event) => {
    if (menu.hasAttribute('open') && !menu.contains(event.target)) close();
  });
  doc.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menu.hasAttribute('open')) return;
    close();
    menu.querySelector('summary')?.focus();
  });
}
