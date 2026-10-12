import type { ReactNode } from 'react';
import { useSidebarLayout } from '../lib/sidebar';
import { BottomBar } from './BottomBar';
import { Sidebar, useSidebarState, type NavItem } from './Sidebar';
import { TopBar } from './TopBar';

/** The signed-in frame. */
export function Shell({ items, onSignOut, children }: { items: readonly NavItem[]; /** Absent for a visitor who has not signed in. */ onSignOut?: () => void; children: ReactNode }) {
  const layout = useSidebarLayout();
  const state = useSidebarState(layout);
  return (
    <div className="shell" data-layout={layout} data-pinned={state.pinned && layout === 'rail'}>
      {layout === 'rail' && <Sidebar items={items} state={state} {...(onSignOut ? { onSignOut } : {})} />}
      <div className="shell__main">
        <TopBar state={state} />
        {children}
      </div>
      {layout === 'touch' && <BottomBar items={items} {...(onSignOut ? { onSignOut } : {})} />}
    </div>
  );
}
