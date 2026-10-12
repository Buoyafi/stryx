import { Link } from 'react-router-dom';
import lockupSource from '../../../../brand/stryx-lockup.svg?raw';
import { toggleTheme } from '../lib/brand';
import { wrapAtomViewport } from '../lib/brand-svg';
import { SunIcon, MoonIcon } from '../lib/icons';

// The lockup is inlined, not an <img>, so its colours follow the theme.
const LOCKUP_HTML = wrapAtomViewport(lockupSource)
  .replace(/<metadata>[\s\S]*?<\/metadata>/, '')
  .replace(' xmlns:c2pa="http://c2pa.org/manifest"', '')
  .replace('<svg ', '<svg class="stryx-logo stryx-lockup" ');

/** Full-bleed top bar: logo lockup flush left, theme toggle flush right. */
export function Header() {
  return (
    <header className="app-header">
      <Link to="/" className="brand-link" aria-label="Stryx home">
        <span dangerouslySetInnerHTML={{ __html: LOCKUP_HTML }} />
      </Link>
      <button type="button" className="theme-toggle" onClick={toggleTheme} aria-label="Toggle dark and light mode">
        <SunIcon className="icon-sun" aria-hidden />
        <MoonIcon className="icon-moon" aria-hidden />
      </button>
    </header>
  );
}
