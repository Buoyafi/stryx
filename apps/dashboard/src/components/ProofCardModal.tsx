import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '@stryx/toast-ui';
import type { HistoryEntry } from '../lib/mint-history';
import {
  CARD_W,
  MARGIN,
  SCALE,
  loadImage,
  markImageSource,
  wordmarkImageSource,
  paintProofCard,
  proofFileName,
  proofModel,
  readProofTokens,
  type ProofAssets,
} from '../lib/proof-card';
import { printImage } from '../lib/proof-print';
import { MARK_HTML, WORDMARK_HTML } from '../lib/brand-svg';
import { useCollectionInfo } from '../lib/useCollectionName';

const shortContract = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Makes the proof-of-mint card for a finished run: a preview, what to include, and Save image, Copy and Print. */
export function ProofCardModal({ entry, onClose }: { entry: HistoryEntry; onClose: () => void }) {
  const { name, imageUrl } = useCollectionInfo(entry.chainId, entry.nftContract);
  const title = name ?? `Contract ${shortContract(entry.nftContract)}`;
  const model = useMemo(() => proofModel(entry, { title, imageUrl }), [entry, title, imageUrl]);
  const [showAddresses, setShowAddresses] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<null | 'save' | 'copy' | 'print'>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const assets = useRef<{ key: string; value: ProofAssets } | null>(null);

  // The collection image comes from another site.
  const artBlocked = useRef(false);

  // Fonts and images are awaited first so the first paint is the real one. Returns false if it did not paint.
  const paint = useCallback(async (): Promise<boolean> => {
    const canvas = canvasRef.current;
    if (!canvas) return false;
    try {
      await document.fonts?.load('650 22px "Inter Variable"');
      await document.fonts?.load('500 14px "Inter Variable"');
    } catch {
      // Fall back to the system font rather than not drawing.
    }
    const tokens = readProofTokens();
    const artUrl = artBlocked.current ? null : model.imageUrl;
    const key = `${tokens.ink}|${tokens.accent}|${artUrl ?? ''}`;
    if (assets.current?.key !== key) {
      const [mark, wordmark, art] = await Promise.all([
        loadImage(markImageSource(MARK_HTML, tokens)),
        loadImage(wordmarkImageSource(WORDMARK_HTML, tokens)),
        artUrl ? loadImage(artUrl, true) : Promise.resolve(null),
      ]);
      assets.current = { key, value: { mark, wordmark, art } };
    }
    const options = { showAddresses };
    // Once to learn the height, once at that height.
    const probe = document.createElement('canvas');
    probe.width = (CARD_W + MARGIN * 2) * SCALE;
    probe.height = 2100 * SCALE;
    const probeCtx = probe.getContext('2d');
    if (!probeCtx) return false;
    const height = paintProofCard(probeCtx, model, options, tokens, assets.current.value);
    canvas.width = (CARD_W + MARGIN * 2) * SCALE;
    canvas.height = (height + MARGIN * 2) * SCALE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    paintProofCard(ctx, model, options, tokens, assets.current.value, height);
    return true;
  }, [model, showAddresses]);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    void paint().then((ok) => {
      if (!cancelled && ok) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [paint]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function toBlob(): Promise<Blob | null> {
    return new Promise((resolve) => {
      try {
        canvasRef.current?.toBlob((b) => resolve(b), 'image/png');
      } catch {
        resolve(null);
      }
    });
  }

  async function exportable(): Promise<Blob | null> {
    const blob = await toBlob();
    if (blob || !model.imageUrl || artBlocked.current) return blob;
    artBlocked.current = true;
    if (!(await paint())) return null;
    return toBlob();
  }

  async function save() {
    setBusy('save');
    const blob = await exportable();
    setBusy(null);
    if (!blob) {
      toast.error('Could not save the image', 'Try again in a moment.');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = proofFileName(model, entry.at);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast.success('Proof card saved');
  }

  async function copy() {
    setBusy('copy');
    const blob = await exportable();
    setBusy(null);
    try {
      if (!blob || typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error('unsupported');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast.success('Copied', 'Paste it into a post or a chat.');
    } catch {
      toast.error('Could not copy the image', 'Use Save image instead.');
    }
  }

  async function print() {
    setBusy('print');
    const blob = await exportable();
    setBusy(null);
    if (!blob || !canvasRef.current) {
      toast.error('Could not prepare the card for printing');
      return;
    }
    printImage(canvasRef.current.toDataURL('image/png'));
  }

  const canCopy = typeof ClipboardItem !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.clipboard?.write;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal proof-modal" role="dialog" aria-modal="true" aria-labelledby="proof-title" onClick={(e) => e.stopPropagation()}>
        <div className="proof-modal__head">
          <h2 id="proof-title">Proof of mint</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <div className={`proof-modal__preview${ready ? '' : ' is-loading'}`}>
          <canvas ref={canvasRef} aria-label={`Proof of mint for ${title}: ${model.confirmed} of ${model.total} confirmed`} role="img" />
        </div>

        <label className="proof-modal__option">
          <input type="checkbox" checked={showAddresses} onChange={(e) => setShowAddresses(e.target.checked)} disabled={model.addresses.length === 0} />
          <span>
            <b>Show wallet addresses</b>
            <small>Off by default, so sharing a win does not reveal your wallets.</small>
          </span>
        </label>

        <div className="proof-modal__actions">
          {canCopy && (
            <button type="button" onClick={() => void copy()} disabled={!ready || busy !== null}>
              Copy
            </button>
          )}
          <button type="button" onClick={() => void print()} disabled={!ready || busy !== null}>
            Print
          </button>
          <button type="button" className="primary" onClick={() => void save()} disabled={!ready || busy !== null}>
            Save image
          </button>
        </div>

        {model.txUrl && (
          <p className="proof-modal__verify">
            Anyone can check this on the block explorer:{' '}
            <a href={model.txUrl} target="_blank" rel="noreferrer noopener">
              open the transaction ↗
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
