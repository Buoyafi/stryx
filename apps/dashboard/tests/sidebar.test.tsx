// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Shell } from '../src/components/Shell';
import type { NavItem } from '../src/components/Sidebar';
import { DisperseIcon, HomeIcon, MintIcon, OperationsIcon, WalletIcon } from '../src/lib/icons';
import { PIN_STORAGE_KEY, isExpanded, layoutFor, readPinned, writePinned } from '../src/lib/sidebar';

const ITEMS: NavItem[] = [
  { to: '/activity', label: 'Activity', Icon: OperationsIcon, mobile: 'tab' },
  { to: '/wallets', label: 'Wallets', Icon: WalletIcon, mobile: 'tab' },
  { to: '/mint', label: 'Mint', Icon: MintIcon, mobile: 'tab' },
  { to: '/home', label: 'Home', Icon: HomeIcon, mobile: 'tab' },
  { to: '/disperse', label: 'Disperse', Icon: DisperseIcon, mobile: 'more', hint: 'Fund your wallets' },
];

function setLayout(kind: 'rail' | 'touch') {
  window.matchMedia = ((q: string) => ({ matches: kind === 'touch', media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
}

function renderShell(onSignOut = () => {}) {
  return render(
    <MemoryRouter initialEntries={['/activity']}>
      <Shell items={ITEMS} onSignOut={onSignOut}>
        <main>page</main>
      </Shell>
    </MemoryRouter>,
  );
}

const sidebar = () => document.querySelector('.sidebar') as HTMLElement;
const isOpen = () => sidebar().classList.contains('is-expanded');
function pointer(el: Element, type: 'pointerenter' | 'pointerleave', pointerType: string) {
  const e = new MouseEvent(type, { bubbles: false });
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  // React's onPointerEnter listens to pointerover/out; dispatch the bubbling pair it maps from.
  const mapped = new MouseEvent(type === 'pointerenter' ? 'pointerover' : 'pointerout', { bubbles: true, relatedTarget: type === 'pointerenter' ? document.body : document.body });
  Object.defineProperty(mapped, 'pointerType', { value: pointerType });
  act(() => void el.dispatchEvent(mapped));
}

beforeEach(() => {
  window.localStorage.clear();
  setLayout('rail');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.style.overflow = '';
});

describe('sidebar logic', () => {
  it('reads and writes the pin, and survives storage that throws', () => {
    expect(readPinned()).toBe(false);
    writePinned(true);
    expect(window.localStorage.getItem(PIN_STORAGE_KEY)).toBe('1');
    expect(readPinned()).toBe(true);
    writePinned(false);
    expect(readPinned()).toBe(false);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } };
    expect(readPinned(broken)).toBe(false);
    expect(() => writePinned(true, broken)).not.toThrow();
    expect(readPinned(null)).toBe(false);
  });

  it('is expanded when pinned, hovered or keyboard-focused on the rail, and never on touch', () => {
    const base = { layout: 'rail' as const, pinned: false, hovered: false, focused: false };
    expect(isExpanded(base)).toBe(false);
    expect(isExpanded({ ...base, pinned: true })).toBe(true);
    expect(isExpanded({ ...base, hovered: true })).toBe(true);
    expect(isExpanded({ ...base, focused: true })).toBe(true);
    expect(isExpanded({ ...base, layout: 'touch', hovered: true, pinned: true })).toBe(false); // touch has no rail to expand
    expect(layoutFor(true)).toBe('touch');
    expect(layoutFor(false)).toBe('rail');
  });
});

describe('Sidebar as a rail', () => {
  it('lists every section in order, each a link with its name, and Sign out', () => {
    renderShell();
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Activity', 'Wallets', 'Mint', 'Home', 'Disperse']);
    expect(within(nav).getByRole('link', { name: 'Disperse' }).getAttribute('href')).toBe('/disperse');
    expect(screen.getByRole('button', { name: 'Sign out' })).not.toBeNull();
  });

  it('is collapsed by default, but the labels are still in the accessibility tree', () => {
    renderShell();
    expect(isOpen()).toBe(false);
    expect(screen.getByRole('link', { name: 'Wallets' })).not.toBeNull(); // named even while only the icon shows
  });

  it('marks the current section', () => {
    renderShell();
    expect(screen.getByRole('link', { name: 'Activity' }).className).toContain('active');
    expect(screen.getByRole('link', { name: 'Wallets' }).className).not.toContain('active');
  });

  it('expands when the mouse enters and collapses when it leaves', () => {
    renderShell();
    pointer(sidebar(), 'pointerenter', 'mouse');
    expect(isOpen()).toBe(true);
    pointer(sidebar(), 'pointerleave', 'mouse');
    expect(isOpen()).toBe(false);
  });

  it('does NOT expand on a touch pointer (touch has no hover)', () => {
    renderShell();
    pointer(sidebar(), 'pointerenter', 'touch');
    expect(isOpen()).toBe(false);
  });

  // jsdom does not track keyboard modality, so nothing ever matches :focus-visible there. Treat focus as
  // keyboard focus for these two tests; the real behaviour (Tab, and NOT a mouse click) is checked in Chromium.
  function asKeyboardFocus() {
    const real = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, sel: string) {
      return sel === ':focus-visible' ? true : real.call(this, sel);
    });
  }

  it('expands when keyboard focus moves in, and collapses when focus leaves', () => {
    asKeyboardFocus();
    renderShell();
    act(() => screen.getByRole('link', { name: 'Wallets' }).focus());
    expect(isOpen()).toBe(true);
    act(() => (document.activeElement as HTMLElement).blur());
    expect(isOpen()).toBe(false);
  });

  it('does NOT expand on a plain focus that is not keyboard focus (a mouse click also focuses a link)', () => {
    renderShell();
    screen.getByRole('link', { name: 'Wallets' }).focus(); // jsdom: never :focus-visible
    expect(isOpen()).toBe(false);
  });

  it('Escape collapses it', () => {
    asKeyboardFocus();
    renderShell();
    pointer(sidebar(), 'pointerenter', 'mouse');
    act(() => screen.getByRole('link', { name: 'Wallets' }).focus());
    expect(isOpen()).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(isOpen()).toBe(false);
  });

  it('speeds up the electrons (is-charged on the atom only) each time it opens, and clears it', () => {
    vi.useFakeTimers();
    renderShell();
    const brand = document.querySelector('.sidebar .sidebar__brand')!;
    expect(brand.classList.contains('is-charged')).toBe(false); // not on first render
    pointer(sidebar(), 'pointerenter', 'mouse');
    expect(brand.classList.contains('is-charged')).toBe(true);
    act(() => void vi.advanceTimersByTime(900));
    expect(brand.classList.contains('is-charged')).toBe(false);
    pointer(sidebar(), 'pointerleave', 'mouse');
    expect(brand.classList.contains('is-charged')).toBe(false); // closing does not charge
    expect(document.querySelectorAll('.is-charged')).toHaveLength(0);
  });

  it('the atom is inline SVG (not an <img>), decorative, with the wordmark beside it', () => {
    renderShell();
    const brand = document.querySelector('.sidebar__brand')!;
    expect(brand.querySelector('img')).toBeNull();
    expect(brand.querySelectorAll('svg')).toHaveLength(2);
    expect(brand.querySelector('svg.sidebar__mark')!.getAttribute('aria-hidden')).toBe('true');
    expect(brand.querySelector('svg.sidebar__wordmark')).not.toBeNull();
    expect(brand.querySelector('metadata')).toBeNull();
    expect(brand.classList.contains('stryx-logo')).toBe(true); // so chargeLogo() (theme switch, mint confirm) reaches it too
  });

  it('has no hamburger: the trigger is the atom', () => {
    renderShell();
    const trigger = document.querySelector('.sidebar__trigger')!;
    expect(trigger.querySelector('.sidebar__mark')).not.toBeNull();
    expect(document.querySelector('.sidebar path[d="M3 6h14M3 10h14M3 14h14"]')).toBeNull();
  });

  it('calls sign out', () => {
    const onSignOut = vi.fn();
    renderShell(onSignOut);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

describe('the pin', () => {
  // Pinning is done by clicking the atom itself: there is no separate footer
  // button (it was a redundant second control for the same toggle).
  it('keeps it expanded with no hover, and is remembered', () => {
    const first = renderShell();
    const pin = screen.getByRole('button', { name: 'Pin navigation open' });
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pin);
    expect(isOpen()).toBe(true);
    expect(sidebar().classList.contains('is-pinned')).toBe(true);
    expect(document.querySelector('.shell')!.getAttribute('data-pinned')).toBe('true');
    expect(window.localStorage.getItem(PIN_STORAGE_KEY)).toBe('1');

    first.unmount();
    renderShell(); // a reload
    expect(isOpen()).toBe(true);
    expect(screen.getByRole('button', { name: 'Unpin navigation' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('stays open when the mouse leaves and when Escape is pressed (Escape does not unpin)', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Pin navigation open' }));
    pointer(sidebar(), 'pointerenter', 'mouse');
    pointer(sidebar(), 'pointerleave', 'mouse');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(isOpen()).toBe(true);
  });

  it('unpins with a second click, collapsing it', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Pin navigation open' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unpin navigation' }));
    expect(isOpen()).toBe(false);
    expect(window.localStorage.getItem(PIN_STORAGE_KEY)).toBe('0');
  });
});

describe('Phone layout: the floating bottom bar', () => {
  beforeEach(() => setLayout('touch'));

  const bar = () => screen.getByRole('navigation', { name: 'Main' });

  it('has no rail: four tabs and a More button, and the top bar carries the whole lockup as a link home', () => {
    renderShell();
    expect(document.querySelector('.sidebar')).toBeNull();
    expect(document.querySelector('.shell')!.getAttribute('data-layout')).toBe('touch');
    expect(within(bar()).getAllByRole('link').map((l) => l.textContent)).toEqual(['Activity', 'Wallets', 'Mint', 'Home']);
    expect(within(bar()).getByRole('button', { name: 'More' }).getAttribute('aria-expanded')).toBe('false');
    const brand = screen.getByRole('link', { name: 'Stryx home' });
    expect(brand.getAttribute('href')).toBe('/home');
    expect(brand.querySelectorAll('svg')).toHaveLength(2); // atom and name
  });

  it('marks the current tab', () => {
    renderShell();
    expect(within(bar()).getByRole('link', { name: 'Activity' }).className).toContain('active');
    expect(within(bar()).getByRole('link', { name: 'Wallets' }).className).not.toContain('active');
  });

  it('keeps at most four tabs, and sends everything else to More', () => {
    const many: NavItem[] = [...ITEMS.slice(0, 4), { to: '/extra', label: 'Extra', Icon: WalletIcon, mobile: 'tab' }];
    render(
      <MemoryRouter initialEntries={['/activity']}>
        <Shell items={many} onSignOut={() => {}}>
          <main>page</main>
        </Shell>
      </MemoryRouter>,
    );
    expect(within(bar()).getAllByRole('link')).toHaveLength(4);
    fireEvent.click(within(bar()).getByRole('button', { name: 'More' }));
    expect(within(screen.getByRole('dialog')).getByRole('link', { name: /Extra/ })).not.toBeNull();
  });

  it('opens More as a modal sheet with the other sections, the wallet, appearance and sign out', () => {
    renderShell();
    fireEvent.click(within(bar()).getByRole('button', { name: 'More' }));
    const dialog = screen.getByRole('dialog', { name: 'More' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(within(dialog).getByRole('link', { name: /Disperse/ }).getAttribute('href')).toBe('/disperse');
    expect(within(dialog).getByText('Fund your wallets')).not.toBeNull();
    expect(within(dialog).getByRole('radiogroup', { name: 'Appearance' })).not.toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Sign out' })).not.toBeNull();
    expect(document.body.style.overflow).toBe('hidden');
    expect(within(bar()).getByRole('button', { name: 'Close menu' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('closes on a tap outside, on Escape, on the close button, and on choosing a section, and gives focus back', () => {
    renderShell();
    const open = () => fireEvent.click(within(bar()).getByRole('button', { name: 'More' }));
    open();
    fireEvent.click(document.querySelector('.more-sheet__scrim')!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');

    open();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    open();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Close menu' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(within(bar()).getByRole('button', { name: 'More' }));

    open();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: /Disperse/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('signs out from the sheet', () => {
    const onSignOut = vi.fn();
    renderShell(onSignOut);
    fireEvent.click(within(bar()).getByRole('button', { name: 'More' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('switches appearance from the sheet through the shared theme toggle', () => {
    const toggle = vi.fn();
    (window as unknown as { toggleStryxTheme: () => void }).toggleStryxTheme = toggle;
    document.documentElement.dataset.theme = 'dark';
    renderShell();
    fireEvent.click(within(bar()).getByRole('button', { name: 'More' }));
    const group = screen.getByRole('radiogroup', { name: 'Appearance' });
    expect(within(group).getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(group).getByRole('radio', { name: 'Light' }));
    expect(toggle).toHaveBeenCalledTimes(1);
    fireEvent.click(within(group).getByRole('radio', { name: 'Light' })); // already light: no second toggle
    expect(toggle).toHaveBeenCalledTimes(1);
    delete (window as unknown as { toggleStryxTheme?: () => void }).toggleStryxTheme;
  });
});

describe('the desktop top bar', () => {
  it('carries the name beside the rail atom', () => {
    setLayout('rail');
    renderShell();
    expect(document.querySelector('.topbar__name svg.sidebar__wordmark')).not.toBeNull();
    expect(screen.queryByRole('link', { name: 'Stryx home' })).toBeNull();
  });
});
