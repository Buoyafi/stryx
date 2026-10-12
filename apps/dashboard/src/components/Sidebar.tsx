import { useLayoutEffect, useRef, useState, type FunctionComponent, type KeyboardEvent, type SVGProps } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { chargeElement } from '../lib/brand';
import { MARK_HTML, WORDMARK_HTML } from '../lib/brand-svg';
import { SignOutIcon } from '../lib/icons';
import { isExpanded, readPinned, writePinned, type SidebarLayout } from '../lib/sidebar';
import { ConnectWallet } from './connect-wallet/ConnectWallet';

export interface NavItem {
  to: string;
  label: string;
  Icon: FunctionComponent<SVGProps<SVGSVGElement>>;
  /** Where this section sits on a phone. */
  mobile?: 'tab' | 'more';
  /** One line under the label in the More sheet. */
  hint?: string;
  /** A visitor without an account sees this section locked; it takes them to Home. */
  locked?: boolean;
}

/** The label a screen reader hears for a locked section. */
export const lockedLabel = (item: NavItem) => `${item.label}, needs an invite code`;

/** A small padlock badge on a locked section's icon. */
export function NavLock({ inline = false }: { inline?: boolean }) {
  return (
    <span className={`nav-lock${inline ? ' nav-lock--inline' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <rect x="2.5" y="5.25" width="7" height="5" rx="1.2" fill="currentColor" stroke="none" />
        <path d="M4 5.25V4a2 2 0 0 1 4 0v1.25" />
      </svg>
    </span>
  );
}

/** Keyboard focus, not a mouse click: a click also focuses a link, and should not pop the rail open. */
function isKeyboardFocus(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

export interface SidebarState {
  layout: SidebarLayout;
  pinned: boolean;
  setPinned: (v: boolean) => void;
}

/** The shell owns this so the sidebar and the top bar share the layout. */
export function useSidebarState(layout: SidebarLayout): SidebarState {
  const [pinned, setPinnedState] = useState(() => readPinned());
  const setPinned = (v: boolean) => {
    setPinnedState(v);
    writePinned(v);
  };
  return { layout, pinned, setPinned };
}

/** The atom, and the wordmark that slides in beside it. Both inside one `.stryx-logo`, so chargeLogo() reaches them too. */
export function SidebarBrand({ brandRef }: { brandRef?: React.Ref<HTMLSpanElement> }) {
  return (
    <span className="stryx-logo sidebar__brand" ref={brandRef}>
      <span className="sidebar__mark-box" dangerouslySetInnerHTML={{ __html: MARK_HTML }} />
      <span className="sidebar__wordmark-box" dangerouslySetInnerHTML={{ __html: WORDMARK_HTML }} />
    </span>
  );
}

/** The desktop navigation: a slim icon rail. */
export function Sidebar({ items, onSignOut, state }: { items: readonly NavItem[]; /** Absent for a visitor: no sign-out, no wallet button. */ onSignOut?: () => void; state: SidebarState }) {
  const { layout, pinned, setPinned } = state;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const brandRef = useRef<HTMLSpanElement>(null);
  const expanded = isExpanded({ layout, pinned, hovered, focused });

  // Electrons speed up briefly each time it OPENS (not on first render, and not when it closes).
  const wasExpanded = useRef(expanded);
  useLayoutEffect(() => {
    if (expanded && !wasExpanded.current) chargeElement(brandRef.current);
    wasExpanded.current = expanded;
  }, [expanded]);

  const collapse = () => {
    setHovered(false);
    setFocused(false);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      collapse();
      (e.target as HTMLElement).blur?.();
    }
  };

  return (
    <aside
      id="sidebar"
      className={`sidebar${expanded ? ' is-expanded' : ''}${pinned ? ' is-pinned' : ''}`}
      data-layout={layout}
      aria-label="Main"
      onKeyDown={onKeyDown}
      onPointerEnter={(e) => e.pointerType !== 'touch' && setHovered(true)}
      onPointerLeave={(e) => e.pointerType !== 'touch' && setHovered(false)}
      onFocus={(e) => isKeyboardFocus(e.target as Element) && setFocused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocused(false)}
    >
      <div className="sidebar__panel">
        <div className="sidebar__top">
          <button
            type="button"
            className="sidebar__trigger"
            aria-label={pinned ? 'Unpin navigation' : 'Pin navigation open'}
            aria-pressed={pinned}
            aria-controls="sidebar"
            onClick={() => setPinned(!pinned)}
          >
            <SidebarBrand brandRef={brandRef} />
          </button>
        </div>

        <nav aria-label="Sections" className="sidebar__nav">
          {items.map((item) =>
            item.locked ? (
              <Link key={item.to} to="/home" className="sidebar__link is-locked" title={lockedLabel(item)} aria-label={lockedLabel(item)}>
                <span className="nav-icon">
                  <item.Icon aria-hidden />
                  <NavLock />
                </span>
                <span className="sidebar__label">{item.label}</span>
              </Link>
            ) : (
              <NavLink key={item.to} to={item.to} className="sidebar__link" title={item.label}>
                <item.Icon aria-hidden />
                <span className="sidebar__label">{item.label}</span>
              </NavLink>
            ),
          )}
        </nav>

        {onSignOut && (
          <div className="sidebar__foot">
            <ConnectWallet variant="sidebar" menuBeside />
            <button type="button" className="sidebar__link" onClick={onSignOut} title="Sign out">
              <SignOutIcon aria-hidden />
              <span className="sidebar__label">Sign out</span>
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
