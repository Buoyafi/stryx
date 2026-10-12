/**
 * Pure accordion state: exactly one item open at a time (opening one closes any other; opening the
 * already-open one closes it).
 */
export function toggleAccordionItem(items, index) {
  return items.map((item, i) => ({ ...item, open: i === index ? !item.open : false }));
}

/**
 * Wires a FAQ-shaped accordion: `root` contains repeated `[data-accordion-item]` elements, each with
 * one `[data-accordion-trigger]` button and one `[data-accordion-panel]`.
 */
export function mountAccordion(root) {
  if (!root) return;

  const itemEls = Array.from(root.querySelectorAll('[data-accordion-item]'));
  let state = itemEls.map(() => ({ open: false }));

  function render() {
    itemEls.forEach((itemEl, i) => {
      const trigger = itemEl.querySelector('[data-accordion-trigger]');
      const panel = itemEl.querySelector('[data-accordion-panel]');
      const open = state[i].open;
      trigger?.setAttribute('aria-expanded', String(open));
      if (panel) panel.hidden = !open;
      itemEl.classList.toggle('is-open', open);
    });
  }

  itemEls.forEach((itemEl, i) => {
    const trigger = itemEl.querySelector('[data-accordion-trigger]');
    trigger?.addEventListener('click', () => {
      state = toggleAccordionItem(state, i);
      render();
    });
  });

  render();
}
