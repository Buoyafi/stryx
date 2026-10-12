/** A handful of small inline icons; no icon library is installed. */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps) {
  return { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, ...props };
}

/**
 * The nav icons share one convention: 24x24, 1.8px round strokes in currentColor, with one filled
 * "electron" dot in the accent colour.
 */

/** A rounded house with a doorway; the window is the electron. */
export function HomeIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path className="stryx-icon-home__body" d="M4 10.8 12 4l8 6.8V19a1.5 1.5 0 0 1-1.5 1.5H15v-4.6a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v4.6H5.5A1.5 1.5 0 0 1 4 19z" />
      <circle className="stryx-icon-home__window" cx="12" cy="11" r="1.5" fill="var(--stryx-accent)" stroke="none" />
    </svg>
  );
}

export function WalletIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="6.5" width="18" height="13" rx="3.5" />
      <path d="M3 10h14.5a3.5 3.5 0 0 1 3.5 3.5" />
      <path d="M6.5 6.5 15 3.8a1.6 1.6 0 0 1 2 1.1l.4 1.6" />
      <circle className="stryx-icon-wallet__clasp" cx="16.5" cy="14.5" r="1.9" fill="var(--stryx-accent)" stroke="none" />
    </svg>
  );
}

export function GenerateWalletIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="2" y="6.5" width="14" height="12" rx="3" />
      <path d="M2 10h10.5a3 3 0 0 1 3 3" />
      <circle className="stryx-icon-genwallet__badge" cx="18.5" cy="6.5" r="4.3" fill="var(--stryx-bg)" stroke="var(--stryx-accent)" />
      <path className="stryx-icon-genwallet__badge" d="M18.5 4.6v3.8M16.6 6.5h3.8" stroke="var(--stryx-accent)" />
    </svg>
  );
}

export function MintIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <g className="stryx-icon-mint__ring">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 1.5v2.2M12 20.3v2.2M1.5 12h2.2M20.3 12h2.2" />
      </g>
      <path className="stryx-icon-mint__bolt" d="M13.6 5.6 8.4 12.6h3.4l-1.4 5.8 5.2-7h-3.4z" fill="var(--stryx-accent)" stroke="none" />
    </svg>
  );
}

/** Public stage: an open shackle: nothing is gating this one. */
export function UnlockedIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="4" y="8" width="10" height="7" rx="1.5" />
      <path d="M6.5 8V5.5a2.5 2.5 0 0 1 5 0" />
    </svg>
  );
}

/** Allow-list stage: a closed shackle: gated by a Merkle proof. */
export function LockedIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="4" y="8" width="10" height="7" rx="1.5" />
      <path d="M6.5 8V5.5a2.5 2.5 0 0 1 5 0V8" />
    </svg>
  );
}

// Theme toggle glyphs.
export function SunIcon(props: IconProps) {
  return (
    <svg {...base({ viewBox: '0 0 24 24', strokeWidth: 2, ...props })}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <svg {...base({ viewBox: '0 0 24 24', strokeWidth: 2, ...props })}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}

export function OperationsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="2.5" y="4" width="19" height="16" rx="4" />
      <path className="stryx-icon-ops__pulse" d="M5.5 13h3l1.8-4 3 8 2-4h3.2" stroke="var(--stryx-accent)" fill="none" />
      <circle className="stryx-icon-ops__dot" cx="18.5" cy="7" r="1.3" fill="var(--stryx-accent)" stroke="none" />
    </svg>
  );
}

/** One source fanning out to three recipients: a hub with three curved spokes. */
export function DisperseIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="5" cy="12" r="2.6" />
      <path d="M7.6 12h4.4M12 12c2 0 3-5.5 5.5-5.5M12 12c2 0 3 5.5 5.5 5.5M12 12h5.5" />
      <circle className="stryx-icon-disperse__dot stryx-icon-disperse__dot--1" cx="19.8" cy="6.5" r="1.9" fill="var(--stryx-accent)" stroke="none" />
      <circle className="stryx-icon-disperse__dot stryx-icon-disperse__dot--2" cx="19.8" cy="12" r="1.9" fill="var(--stryx-accent)" stroke="none" />
      <circle className="stryx-icon-disperse__dot stryx-icon-disperse__dot--3" cx="19.8" cy="17.5" r="1.9" fill="var(--stryx-accent)" stroke="none" />
    </svg>
  );
}

/** A head and shoulders; the head is the electron. */
export function ProfileIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
      <circle cx="12" cy="8.5" r="3.6" />
      <circle cx="12" cy="8.5" r="1.5" fill="var(--stryx-accent)" stroke="none" />
    </svg>
  );
}

/** A shield; the electron sits at its centre. */
export function AdminIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z" />
      <circle cx="12" cy="11.5" r="1.8" fill="var(--stryx-accent)" stroke="none" />
    </svg>
  );
}

export function PinIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M11.5 2.5l4 4-2 .8-2.4 2.4.4 3.1-1.1 1.1-3-3-4.3 4.3M8.6 8.9l-3-3 1.1-1.1 3.1.4L12 2.8" />
    </svg>
  );
}

export function SignOutIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M7 3H4.5A1.5 1.5 0 0 0 3 4.5v9A1.5 1.5 0 0 0 4.5 15H7M11 6l3 3-3 3M14 9H7" />
    </svg>
  );
}

/**
 * The X from the Stryx wordmark (brand/stryx-wordmark.svg): four arms split around a nucleus, in the
 * accent colour, so it follows the theme like the logo does.
 */
export function LogoXIcon(props: IconProps) {
  return (
    <svg width={16} height={16} viewBox="5 -830 990 990" fill="none" {...props}>
      <path d="M100 -620 L420 -400 M580 -270 L900 -50 M900 -620 L580 -400 M420 -270 L100 -50" stroke="var(--stryx-accent)" strokeWidth={150} strokeLinecap="round" />
      <circle cx={500} cy={-334} r={72} fill="var(--stryx-accent)" />
    </svg>
  );
}

/** Four rounded squares: the More button in the phone's bottom bar. */
export function MoreIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="2" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="2" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="2" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="2" />
    </svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
