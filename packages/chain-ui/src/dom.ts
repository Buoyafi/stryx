import { computeTooltipPosition, tooltipModel, type ChainView, type TooltipRow } from './core.js';
import { iconParts } from './icons.js';

export type ChainStatus = 'live' | 'offline';

/** The markup for one chain icon: a real <button> named after the chain, so it is focusable and announced. */
export function chainIconMarkup(chain: ChainView, opts: { status?: ChainStatus; focusable?: boolean } = {}): string {
  const { url, initials, showTestnetBadge } = iconParts(chain);
  const face = url
    ? `<img class="chain-icon__img" src="${escapeHtml(url)}" alt="" width="28" height="28" decoding="async" draggable="false" />`
    : `<span class="chain-icon__fallback" aria-hidden="true">${escapeHtml(initials)}</span>`;
  const badge = showTestnetBadge ? '<span class="chain-icon__badge" aria-hidden="true">T</span>' : '';
  const dot = opts.status ? `<span class="chain-icon__dot chain-icon__dot--${opts.status}" aria-hidden="true"></span>` : '';
  const tabindex = opts.focusable === false ? ' tabindex="-1"' : '';
  return (
    `<button type="button" class="chain-icon" data-chain-id="${chain.chainId}" aria-label="${escapeHtml(chain.name)}"${tabindex}>` +
    face +
    badge +
    dot +
    '</button>'
  );
}

export interface ChainTooltipOptions {
  /** What to show for a chain id, or null to show nothing. `extraRows` is where a caller adds its own data. */
  resolve: (chainId: number) => { chain: ChainView; extraRows?: readonly TooltipRow[] } | null;
  /** Called when the tooltip opens or closes (the landing page uses it to pause the marquee). */
  onOpenChange?: (open: boolean, anchor: HTMLElement | null) => void;
}

export interface ChainTooltipController {
  close: () => void;
  destroy: () => void;
}

const ANCHOR = '[data-chain-id]';
let instances = 0;

function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true; // engine without the selector: treat any focus as keyboard focus
  }
}

/** One tooltip for every element carrying `data-chain-id`, wired by event delegation on the whole document. */
export function mountChainTooltips(options: ChainTooltipOptions): ChainTooltipController {
  const doc = document;
  const win = window;
  const id = `chain-tip-${++instances}`;

  let tip: HTMLDivElement | null = null;
  let current: HTMLElement | null = null;
  let lastPointerType = 'mouse';

  function ensureTip(): HTMLDivElement {
    if (tip) return tip;
    const el = doc.createElement('div');
    el.className = 'chain-tip';
    el.id = id;
    el.setAttribute('role', 'tooltip');
    el.hidden = true;
    doc.body.appendChild(el);
    tip = el;
    return el;
  }

  function fill(el: HTMLDivElement, chain: ChainView, extraRows: readonly TooltipRow[]) {
    const model = tooltipModel(chain, extraRows);
    el.replaceChildren();
    const title = doc.createElement('strong');
    title.className = 'chain-tip__title';
    title.textContent = model.title;
    const list = doc.createElement('dl');
    list.className = 'chain-tip__rows';
    for (const row of model.rows) {
      const wrap = doc.createElement('div');
      wrap.className = 'chain-tip__row';
      const dt = doc.createElement('dt');
      dt.textContent = row.label;
      const dd = doc.createElement('dd');
      dd.textContent = row.value;
      if (row.tone) dd.className = `chain-tip__value chain-tip__value--${row.tone}`;
      wrap.append(dt, dd);
      list.appendChild(wrap);
    }
    el.append(title, list);
  }

  function place(anchor: HTMLElement) {
    if (!tip) return;
    const a = anchor.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const pos = computeTooltipPosition({
      anchor: { left: a.left, top: a.top, right: a.right, bottom: a.bottom },
      tip: { width: t.width, height: t.height },
      viewport: { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight },
    });
    tip.style.left = `${Math.round(pos.left)}px`;
    tip.style.top = `${Math.round(pos.top)}px`;
    tip.style.setProperty('--chain-tip-arrow-x', `${Math.round(pos.arrowX)}px`);
    tip.dataset.placement = pos.placement;
  }

  function open(anchor: HTMLElement) {
    if (current === anchor) return;
    const found = options.resolve(Number(anchor.dataset.chainId));
    if (!found) return;
    close();
    const el = ensureTip();
    fill(el, found.chain, found.extraRows ?? []);
    el.hidden = false;
    el.classList.remove('is-open');
    place(anchor);
    void el.offsetWidth; // commit the starting style so the entrance transition runs
    el.classList.add('is-open');
    anchor.setAttribute('aria-describedby', id);
    current = anchor;
    options.onOpenChange?.(true, anchor);
  }

  function close() {
    if (!current || !tip) return;
    const anchor = current;
    current = null;
    anchor.removeAttribute('aria-describedby');
    tip.classList.remove('is-open');
    tip.hidden = true;
    options.onOpenChange?.(false, anchor);
  }

  const anchorOf = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element ? (target.closest(ANCHOR) as HTMLElement | null) : null;

  const onPointerDown = (e: Event) => {
    lastPointerType = (e as PointerEvent).pointerType || 'mouse';
    // A press anywhere that is not the open icon closes it (this is what makes "tap elsewhere closes" work).
    if (current && !current.contains(e.target as Node)) close();
  };
  const onPointerOver = (e: Event) => {
    if ((e as PointerEvent).pointerType === 'touch') return; // touch is handled by click
    const a = anchorOf(e.target);
    if (a) open(a);
  };
  const onPointerOut = (e: Event) => {
    if ((e as PointerEvent).pointerType === 'touch') return;
    const a = anchorOf(e.target);
    if (!a || a !== current) return;
    const to = (e as PointerEvent).relatedTarget as Node | null;
    if (to && a.contains(to)) return;
    if (isFocusVisible(a)) return; // keyboard focus keeps it open
    close();
  };
  const onFocusIn = (e: Event) => {
    const a = anchorOf(e.target);
    if (a && isFocusVisible(a)) open(a);
  };
  const onFocusOut = (e: Event) => {
    const a = anchorOf(e.target);
    if (!a || a !== current) return;
    const to = (e as FocusEvent).relatedTarget as Node | null;
    if (to && a.contains(to)) return;
    close();
  };
  const onClick = (e: Event) => {
    const a = anchorOf(e.target);
    if (!a) return;
    if ((e as MouseEvent).detail === 0) return; // keyboard-synthesised click: focus already handled it
    if (lastPointerType !== 'touch' && lastPointerType !== 'pen') return; // mouse: hover handled it
    if (current === a) close();
    else open(a);
  };
  const onKeyDown = (e: Event) => {
    if ((e as KeyboardEvent).key === 'Escape') close();
  };
  const onMove = () => {
    if (current) place(current);
  };

  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('pointerover', onPointerOver);
  doc.addEventListener('pointerout', onPointerOut);
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('focusout', onFocusOut);
  doc.addEventListener('click', onClick);
  doc.addEventListener('keydown', onKeyDown);
  win.addEventListener('scroll', onMove, { capture: true, passive: true });
  win.addEventListener('resize', onMove);

  return {
    close,
    destroy() {
      close();
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('pointerover', onPointerOver);
      doc.removeEventListener('pointerout', onPointerOut);
      doc.removeEventListener('focusin', onFocusIn);
      doc.removeEventListener('focusout', onFocusOut);
      doc.removeEventListener('click', onClick);
      doc.removeEventListener('keydown', onKeyDown);
      win.removeEventListener('scroll', onMove, { capture: true });
      win.removeEventListener('resize', onMove);
      tip?.remove();
      tip = null;
    },
  };
}

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
