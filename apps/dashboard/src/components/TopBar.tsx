import { Link } from 'react-router-dom';
import { toggleTheme } from '../lib/brand';
import { WORDMARK_HTML } from '../lib/brand-svg';
import { SunIcon, MoonIcon } from '../lib/icons';
import type { SidebarState } from './Sidebar';
import { SidebarBrand } from './Sidebar';

/** The bar across the top of the content. */
export function TopBar({ state }: { state: SidebarState }) {
  const touch = state.layout === 'touch';
  return (
    <header className="topbar">
      {touch ? (
        <Link to="/home" className="topbar__brand" aria-label="Stryx home">
          <SidebarBrand />
        </Link>
      ) : (
        <span className="topbar__name" aria-hidden="true" dangerouslySetInnerHTML={{ __html: WORDMARK_HTML }} />
      )}
      <button type="button" className="theme-toggle" onClick={toggleTheme} aria-label="Toggle dark and light mode">
        <SunIcon className="icon-sun" aria-hidden />
        <MoonIcon className="icon-moon" aria-hidden />
      </button>
    </header>
  );
}
