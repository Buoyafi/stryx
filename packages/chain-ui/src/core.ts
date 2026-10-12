import { CHAINS, networkLabel, type Chain } from '@stryx/chains';

/** A chain as the UI needs it: a subset of the registry's Chain. */
export type ChainView = Pick<Chain, 'chainId' | 'name' | 'isTestnet' | 'icon'> & {
  nativeCurrency?: Pick<Chain['nativeCurrency'], 'symbol'>;
};

/** The registry entry for a chain id, or a bare view (name only, lettered fallback icon) if it is unknown. */
export function viewForChainId(chainId: number, fallbackName?: string): ChainView {
  const known = CHAINS.find((c) => c.chainId === chainId);
  if (known) return known;
  return { chainId, name: fallbackName ?? `Chain ${chainId}`, isTestnet: false, icon: null };
}

/** The first two letters of a chain's name, upper-cased, for the fallback badge. */
export function chainInitials(name: string): string {
  const letters = name.replace(/[^\p{L}]/gu, '').slice(0, 2).toUpperCase();
  return letters.length > 0 ? letters : '?';
}

export type RowTone = 'ok' | 'fail' | 'idle';

export interface TooltipRow {
  label: string;
  value: string;
  /** Adds a glyph (check or cross) so the state never depends on colour alone. */
  tone?: RowTone;
}

export interface TooltipModel {
  title: string;
  rows: TooltipRow[];
}

/** What a chain's tooltip says. */
export function tooltipModel(chain: ChainView, extraRows: readonly TooltipRow[] = []): TooltipModel {
  const rows: TooltipRow[] = [
    { label: 'Chain ID', value: String(chain.chainId) },
    { label: 'Network', value: networkLabel(chain) },
  ];
  if (chain.nativeCurrency) rows.push({ label: 'Gas token', value: chain.nativeCurrency.symbol });
  return { title: chain.name, rows: [...rows, ...extraRows] };
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface TooltipPosition {
  left: number;
  top: number;
  placement: 'top' | 'bottom';
  /** Where the pointer arrow sits, in px from the tooltip's left edge. */
  arrowX: number;
}

/** Where to put a fixed-position tooltip. */
export function computeTooltipPosition(input: {
  anchor: Rect;
  tip: Size;
  viewport: Size;
  gap?: number;
  margin?: number;
}): TooltipPosition {
  const { anchor, tip, viewport } = input;
  const gap = input.gap ?? 10;
  const margin = input.margin ?? 8;

  const roomAbove = anchor.top - margin;
  const roomBelow = viewport.height - anchor.bottom - margin;
  const need = tip.height + gap;
  const placement: 'top' | 'bottom' = roomAbove >= need || roomAbove >= roomBelow ? 'top' : 'bottom';
  const top = placement === 'top' ? anchor.top - gap - tip.height : anchor.bottom + gap;

  const anchorCentre = (anchor.left + anchor.right) / 2;
  const maxLeft = viewport.width - margin - tip.width;
  const left = Math.max(margin, Math.min(anchorCentre - tip.width / 2, maxLeft));

  const edge = 14;
  const arrowX = Math.max(edge, Math.min(anchorCentre - left, tip.width - edge));
  return { left, top, placement, arrowX };
}
