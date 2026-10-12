import { chainInitials, type ChainView } from './core.js';

// Every committed icon file, bundled by Vite as a local asset.
const ICON_URLS = import.meta.glob('../../chains/icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** The bundled URL for a registry `icon` path (e.g. "icons/base.svg"), or null if there is none. */
export function iconUrl(icon: string | null): string | null {
  if (!icon) return null;
  return ICON_URLS[`../../chains/${icon}`] ?? null;
}

/** Everything a renderer needs to draw a chain's icon, so the DOM and React bindings cannot drift apart. */
export interface IconParts {
  /** Set when there is a real logo. */
  url: string | null;
  /** Two letters for the fallback badge (always set; used only when `url` is null). */
  initials: string;
  /** Testnets show a small "T" badge. */
  showTestnetBadge: boolean;
}

export function iconParts(chain: ChainView): IconParts {
  return { url: iconUrl(chain.icon), initials: chainInitials(chain.name), showTestnetBadge: chain.isTestnet };
}
