import { useState } from 'react';

/** One NFT's thumbnail. */
export function NftThumb({ imageUrl, tokenId, size = 40 }: { imageUrl?: string; tokenId: string; size?: number }) {
  const [failed, setFailed] = useState(false);
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

  if (imageUrl && !failed) {
    return (
      <span style={boxStyle}>
        <img src={imageUrl} alt="" width={size} height={size} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onError={() => setFailed(true)} />
      </span>
    );
  }

  return (
    <span
      style={{ ...boxStyle, background: 'var(--dash-raised)', borderBottom: '2px solid var(--stryx-accent)', color: 'var(--stryx-sub)', fontSize: size * 0.26 }}
      className="mono"
      title={`Token #${tokenId}`}
    >
      #{tokenId.length > 5 ? `${tokenId.slice(0, 4)}…` : tokenId}
    </span>
  );
}
