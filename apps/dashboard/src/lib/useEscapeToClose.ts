import { useEffect, useRef, useState } from 'react';

type Layer = { order: number; close: (() => void) | undefined };

// Every open layer, so Escape reaches only the one on top: a prompt over a dialog closes alone.
const layers = new Set<Layer>();
let opened = 0;

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  let top: Layer | null = null;
  for (const layer of layers) if (!top || layer.order > top.order) top = layer;
  // A top layer that must stay open (close undefined) swallows the key: nothing under it closes either.
  top?.close?.();
}

/** Escape closes a dialog, the same way a click on its backdrop does. */
export function useEscapeToClose(close: (() => void) | undefined): void {
  // Numbered while rendering: a parent renders before its child, so a child opened in the same pass
  // still sits above it.
  const [order] = useState(() => ++opened);
  const layer = useRef<Layer>({ order, close });
  layer.current.close = close;
  useEffect(() => {
    const mine = layer.current;
    if (layers.size === 0) document.addEventListener('keydown', onKey);
    layers.add(mine);
    return () => {
      layers.delete(mine);
      if (layers.size === 0) document.removeEventListener('keydown', onKey);
    };
  }, []);
}
