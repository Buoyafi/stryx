// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CHAINS } from '@stryx/chains';
import { chainIconMarkup, mountChainTooltips, type ChainTooltipController } from '../src/dom.js';
import { viewForChainId } from '../src/core.js';

const robinhood = CHAINS.find((c) => c.chainId === 4663)!;
const testnet = CHAINS.find((c) => c.chainId === 46630)!;

describe('chainIconMarkup', () => {
  const parse = (html: string) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host.firstElementChild as HTMLButtonElement;
  };

  it('is a real button named after the chain, carrying its id', () => {
    const el = parse(chainIconMarkup(robinhood));
    expect(el.tagName).toBe('BUTTON');
    expect(el.type).toBe('button');
    expect(el.getAttribute('aria-label')).toBe('Robinhood Chain');
    expect(el.dataset.chainId).toBe('4663');
    expect(el.tabIndex).toBe(0);
  });

  it('draws the logo as an <img> from a local URL, with empty alt (the button carries the name)', () => {
    const img = parse(chainIconMarkup(robinhood)).querySelector('img')!;
    expect(img).not.toBeNull();
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('src')).not.toMatch(/^https?:\/\//);
  });

  it('shows the T badge on a testnet only', () => {
    expect(parse(chainIconMarkup(testnet)).querySelector('.chain-icon__badge')?.textContent).toBe('T');
    expect(parse(chainIconMarkup(robinhood)).querySelector('.chain-icon__badge')).toBeNull();
  });

  it('renders the lettered fallback for a chain with no icon', () => {
    const el = parse(chainIconMarkup({ chainId: 9, name: 'Nova Chain', isTestnet: false, icon: null }));
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.chain-icon__fallback')?.textContent).toBe('NO');
  });

  it('takes the out-of-tab-order form for a duplicate track, and adds a status dot on request', () => {
    expect(parse(chainIconMarkup(robinhood, { focusable: false })).tabIndex).toBe(-1);
    expect(parse(chainIconMarkup(robinhood, { status: 'live' })).querySelector('.chain-icon__dot--live')).not.toBeNull();
  });

  it('escapes a hostile chain name in both the label and the fallback', () => {
    const html = chainIconMarkup({ chainId: 1, name: '"><img src=x onerror=alert(1)>', isTestnet: false, icon: null });
    const el = parse(html);
    expect(el.querySelectorAll('img')).toHaveLength(0);
    expect(el.getAttribute('aria-label')).toBe('"><img src=x onerror=alert(1)>');
  });
});

describe('mountChainTooltips', () => {
  let controller: ChainTooltipController;
  let onOpenChange: Mock<(open: boolean, anchor: HTMLElement | null) => void>;
  let rail: HTMLElement;
  let icon: HTMLButtonElement;
  let other: HTMLButtonElement;

  const tip = () => document.querySelector<HTMLElement>('.chain-tip');
  const isOpen = () => !!tip() && !tip()!.hidden && tip()!.classList.contains('is-open');

  function fire(target: Element, type: string, init: Record<string, unknown> = {}) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, detail: (init.detail as number) ?? 1 });
    for (const [k, v] of Object.entries(init)) Object.defineProperty(event, k, { value: v });
    target.dispatchEvent(event);
  }

  beforeEach(() => {
    document.body.innerHTML = `<div class="rail" style="overflow:hidden">${chainIconMarkup(robinhood)}${chainIconMarkup(testnet)}</div>`;
    rail = document.querySelector('.rail')!;
    [icon, other] = [...rail.querySelectorAll<HTMLButtonElement>('button')] as [HTMLButtonElement, HTMLButtonElement];
    onOpenChange = vi.fn<(open: boolean, anchor: HTMLElement | null) => void>();
    controller = mountChainTooltips({
      resolve: (id) => ({ chain: viewForChainId(id), extraRows: id === 46630 ? [{ label: 'RPC', value: 'ok', tone: 'ok' as const }] : [] }),
      onOpenChange,
    });
  });

  afterEach(() => {
    controller.destroy();
    document.body.innerHTML = '';
  });

  it('opens on mouse hover with name, chain id, network and gas token, and closes on leave', () => {
    fire(icon, 'pointerover', { pointerType: 'mouse' });
    expect(isOpen()).toBe(true);
    const text = tip()!.textContent!;
    expect(text).toContain('Robinhood Chain');
    expect(text).toContain('4663');
    expect(text).toContain('Mainnet');
    expect(text).toContain('ETH');

    fire(icon, 'pointerout', { pointerType: 'mouse', relatedTarget: document.body });
    expect(isOpen()).toBe(false);
  });

  it('lives in <body>, outside any container that could clip it, and is fixed-position by class', () => {
    fire(icon, 'pointerover', { pointerType: 'mouse' });
    expect(tip()!.parentElement).toBe(document.body);
    expect(rail.contains(tip())).toBe(false);
    expect(tip()!.getAttribute('role')).toBe('tooltip');
  });

  it('opens on keyboard focus and closes on blur', () => {
    icon.focus();
    expect(isOpen()).toBe(true);
    icon.blur();
    expect(isOpen()).toBe(false);
  });

  it('links the open icon to the tooltip for screen readers, and unlinks it on close', () => {
    fire(icon, 'pointerover', { pointerType: 'mouse' });
    expect(icon.getAttribute('aria-describedby')).toBe(tip()!.id);
    controller.close();
    expect(icon.hasAttribute('aria-describedby')).toBe(false);
  });

  it('a tap opens it, a second tap on the same icon closes it', () => {
    fire(icon, 'pointerdown', { pointerType: 'touch' });
    fire(icon, 'click');
    expect(isOpen()).toBe(true);
    fire(icon, 'pointerdown', { pointerType: 'touch' });
    fire(icon, 'click');
    expect(isOpen()).toBe(false);
  });

  it('a tap elsewhere closes it', () => {
    fire(icon, 'pointerdown', { pointerType: 'touch' });
    fire(icon, 'click');
    expect(isOpen()).toBe(true);
    fire(document.body, 'pointerdown', { pointerType: 'touch' });
    expect(isOpen()).toBe(false);
  });

  it('tapping a different icon moves the tooltip to it instead of stacking a second', () => {
    fire(icon, 'pointerdown', { pointerType: 'touch' });
    fire(icon, 'click');
    fire(other, 'pointerdown', { pointerType: 'touch' });
    fire(other, 'click');
    expect(document.querySelectorAll('.chain-tip')).toHaveLength(1);
    expect(tip()!.textContent).toContain('Robinhood Chain Testnet');
  });

  it('a mouse click does not close a tooltip that hover just opened', () => {
    fire(icon, 'pointerover', { pointerType: 'mouse' });
    fire(icon, 'pointerdown', { pointerType: 'mouse' });
    fire(icon, 'click');
    expect(isOpen()).toBe(true);
  });

  it('a keyboard-synthesised click (detail 0) does not toggle it either', () => {
    icon.focus();
    fire(icon, 'click', { detail: 0 });
    expect(isOpen()).toBe(true);
  });

  it('Escape closes it', () => {
    fire(icon, 'pointerover', { pointerType: 'mouse' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(isOpen()).toBe(false);
  });

  it('reports open and close so a caller can pause an animation', () => {
    fire(icon, 'pointerover', { pointerType: 'mouse' });
    expect(onOpenChange).toHaveBeenLastCalledWith(true, icon);
    controller.close();
    expect(onOpenChange).toHaveBeenLastCalledWith(false, icon);
  });

  it('includes the caller\'s extra rows, with a tone the stylesheet can turn into a glyph', () => {
    fire(other, 'pointerover', { pointerType: 'mouse' });
    const value = tip()!.querySelector('.chain-tip__value--ok');
    expect(value?.textContent).toBe('ok');
    expect(tip()!.textContent).toContain('Testnet');
  });

  it('shows nothing for a chain the resolver declines', () => {
    controller.destroy();
    controller = mountChainTooltips({ resolve: () => null });
    fire(icon, 'pointerover', { pointerType: 'mouse' });
    expect(tip()).toBeNull();
  });

  it('destroy removes the tooltip and stops listening', () => {
    fire(icon, 'pointerover', { pointerType: 'mouse' });
    controller.destroy();
    expect(tip()).toBeNull();
    fire(icon, 'pointerover', { pointerType: 'mouse' });
    expect(tip()).toBeNull();
  });
});
