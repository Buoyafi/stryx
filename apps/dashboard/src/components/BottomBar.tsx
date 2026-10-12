import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { toggleTheme } from '../lib/brand';
import { ChevronRightIcon, LogoXIcon, MoreIcon, SignOutIcon } from '../lib/icons';
import { NavLock, lockedLabel, type NavItem } from './Sidebar';
import { SegmentedControl } from './SegmentedControl';
import { ConnectWallet } from './connect-wallet/ConnectWallet';

/** The bar holds four tabs; anything not marked as a tab lives in the More sheet. */
export const MAX_TABS = 4;

export function splitNav(items: readonly NavItem[]): { tabs: NavItem[]; more: NavItem[] } {
  const tabs = items.filter((i) => i.mobile === 'tab').slice(0, MAX_TABS);
  const more = items.filter((i) => !tabs.includes(i));
  return { tabs, more };
}

type Theme = 'light' | 'dark';
const THEME_OPTIONS: readonly { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];
const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

/** The phone's navigation: a floating bar with up to four tabs and a More button that opens a sheet with the rest. */
export function BottomBar({ items, onSignOut }: { items: readonly NavItem[]; /** Absent for a visitor: no sign-out, no wallet button. */ onSignOut?: () => void }) {
  const { tabs, more } = splitNav(items);
  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();

  // Choosing a section (from the bar or the sheet) closes the sheet.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <>
      {open && <MoreSheet items={more} onSignOut={onSignOut} onClose={() => setOpen(false)} returnFocusTo={moreRef} />}
      <nav className="bottombar" aria-label="Main">
        <div className="bottombar__tabs">
          {tabs.map((item) =>
            item.locked ? (
              <Link key={item.to} to="/home" className="bottombar__tab is-locked" aria-label={lockedLabel(item)}>
                <span className="nav-icon">
                  <item.Icon aria-hidden />
                  <NavLock />
                </span>
                <span>{item.label}</span>
              </Link>
            ) : (
              <NavLink key={item.to} to={item.to} className="bottombar__tab">
                <item.Icon aria-hidden />
                <span>{item.label}</span>
              </NavLink>
            ),
          )}
        </div>
        <button
          ref={moreRef}
          type="button"
          className={`bottombar__more${open ? ' is-open' : ''}`}
          aria-label={open ? 'Close menu' : 'More'}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <LogoXIcon aria-hidden /> : <MoreIcon aria-hidden />}
        </button>
      </nav>
    </>
  );
}

function MoreSheet({
  items,
  onSignOut,
  onClose,
  returnFocusTo,
}: {
  items: readonly NavItem[];
  onSignOut: (() => void) | undefined;
  onClose: () => void;
  returnFocusTo: React.RefObject<HTMLElement>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<Theme>(currentTheme);

  // The page behind does not scroll; focus goes into the sheet and comes back out.
  useEffect(() => {
    const scroll = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.querySelector<HTMLElement>('a, button')?.focus();
    const back = returnFocusTo.current;
    return () => {
      document.body.style.overflow = scroll;
      back?.focus?.();
    };
  }, [returnFocusTo]);

  return (
    <div className="more-sheet">
      <div className="more-sheet__scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="more-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-label="More"
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="more-sheet__grab" aria-hidden="true" />
        {items.length > 0 && (
          <nav aria-label="More sections" className="more-sheet__list">
            {items.map((item) =>
              item.locked ? (
                <Link key={item.to} to="/home" className="more-sheet__item is-locked" aria-label={lockedLabel(item)} onClick={onClose}>
                  <span className="nav-icon">
                    <item.Icon aria-hidden />
                    <NavLock />
                  </span>
                  <span className="more-sheet__text">
                    <b>{item.label}</b>
                    <small>Needs an invite code</small>
                  </span>
                  <ChevronRightIcon className="more-sheet__chev" aria-hidden />
                </Link>
              ) : (
                <NavLink key={item.to} to={item.to} className="more-sheet__item">
                  <item.Icon aria-hidden />
                  <span className="more-sheet__text">
                    <b>{item.label}</b>
                    {item.hint && <small>{item.hint}</small>}
                  </span>
                  <ChevronRightIcon className="more-sheet__chev" aria-hidden />
                </NavLink>
              ),
            )}
          </nav>
        )}
        <hr className="more-sheet__rule" />
        {onSignOut && (
          <div className="more-sheet__wallet">
            <ConnectWallet variant="sidebar" />
          </div>
        )}
        <div className="more-sheet__theme">
          <b>Appearance</b>
          <SegmentedControl
            label="Appearance"
            options={THEME_OPTIONS}
            value={theme}
            onChange={(next) => {
              if (next !== theme) toggleTheme();
              setTheme(next);
            }}
          />
        </div>
        {onSignOut && (
          <button type="button" className="more-sheet__item more-sheet__signout" onClick={onSignOut}>
            <SignOutIcon aria-hidden />
            <span className="more-sheet__text">
              <b>Sign out</b>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
