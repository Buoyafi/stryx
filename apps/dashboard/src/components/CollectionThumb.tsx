import { useEffect, useState } from 'react';
import type { CollectionImageRef } from '../lib/collection-resolve';
import { fetchProxiedImageObjectUrl } from '../lib/collection-resolve';

function monogramLetter(name: string | null, contract: string): string {
  const fromName = name?.trim().charAt(0);
  if (fromName) return fromName.toUpperCase();
  const hex = contract.replace(/^0x/i, '').charAt(0);
  return hex ? hex.toUpperCase() : '?';
}

/** A collection's thumbnail. */
export function CollectionThumb({ image, name, contract, size = 40 }: { image: CollectionImageRef | null; name: string | null; contract: string; size?: number }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    setObjectUrl(null);
    if (!image || image.kind !== 'proxied') return;

    let cancelled = false;
    let created: string | null = null;
    void fetchProxiedImageObjectUrl(image.url).then((url) => {
      if (cancelled) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      if (!url) {
        setFailed(true);
        return;
      }
      created = url;
      setObjectUrl(url);
    });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [image?.kind, image?.url]);

  const src = image?.kind === 'external' ? image.url : image?.kind === 'proxied' ? objectUrl : null;
  const showImage = src !== null && !failed;

  const boxStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: 'var(--radius)',
    overflow: 'hidden',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  if (showImage) {
    return (
      <span style={boxStyle}>
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          onError={() => setFailed(true)}
        />
      </span>
    );
  }

  return (
    <span
      style={{
        ...boxStyle,
        background: 'var(--dash-raised)',
        borderBottom: '2px solid var(--stryx-accent)',
        color: 'var(--stryx-ink)',
        fontWeight: 700,
        fontSize: size * 0.4,
      }}
      aria-hidden
    >
      {monogramLetter(name, contract)}
    </span>
  );
}
