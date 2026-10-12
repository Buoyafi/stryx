import { addressGradient } from '../../lib/avatar';

/** A small circular gradient avatar derived from an address, with no lookup. */
export function AddressAvatar({ address, size = 20 }: { address: string; size?: number }) {
  const { hueRotate, angle } = addressGradient(address);
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        flex: 'none',
        width: size,
        height: size,
        borderRadius: '999px',
        background: `linear-gradient(${angle}deg, var(--stryx-accent), var(--stryx-pending))`,
        filter: `hue-rotate(${hueRotate}deg)`,
      }}
    />
  );
}
