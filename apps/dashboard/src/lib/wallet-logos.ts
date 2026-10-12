/** Wallets the chooser can show a logo for. */
export interface KnownWallet {
  key: string;
  name: string;
  /** EIP-6963 reverse-DNS ids the wallet announces itself with. */
  rdns: readonly string[];
  /** The flag an old-style injected provider sets on itself. */
  flag: string;
  /** Official site, for wallets offered under "More wallets". */
  url?: string;
}

export const KNOWN_WALLETS: readonly KnownWallet[] = [
  { key: 'metamask', name: 'MetaMask', rdns: ['io.metamask', 'io.metamask.flask', 'io.metamask.mobile'], flag: 'isMetaMask', url: 'https://metamask.io' },
  { key: 'rabby', name: 'Rabby', rdns: ['io.rabby'], flag: 'isRabby', url: 'https://rabby.io' },
  { key: 'coinbase', name: 'Coinbase Wallet', rdns: ['com.coinbase.wallet'], flag: 'isCoinbaseWallet', url: 'https://www.coinbase.com/wallet' },
  { key: 'rainbow', name: 'Rainbow', rdns: ['me.rainbow'], flag: 'isRainbow', url: 'https://rainbow.me' },
  { key: 'phantom', name: 'Phantom', rdns: ['app.phantom'], flag: 'isPhantom' },
  { key: 'zerion', name: 'Zerion', rdns: ['io.zerion.wallet'], flag: 'isZerion' },
  { key: 'trust', name: 'Trust Wallet', rdns: ['com.trustwallet.app'], flag: 'isTrust' },
  { key: 'okx', name: 'OKX Wallet', rdns: ['com.okex.wallet'], flag: 'isOkxWallet' },
  { key: 'brave', name: 'Brave Wallet', rdns: ['com.brave.wallet'], flag: 'isBraveWallet' },
];

/** Offered under "More wallets" when not already detected. */
export const MORE_WALLETS = KNOWN_WALLETS.filter((w) => w.url);

export const walletLogoUrl = (key: string): string => `/wallets/${key}.svg`;
export const WALLETCONNECT_LOGO = walletLogoUrl('walletconnect');

/** The known wallet behind an announced wallet: by its rdns, else by its name. */
export function knownWallet(w: { rdns?: string; name?: string }): KnownWallet | null {
  const name = w.name?.trim().toLowerCase();
  return KNOWN_WALLETS.find((k) => (w.rdns && k.rdns.includes(w.rdns)) || (name && k.name.toLowerCase() === name)) ?? null;
}

/** The wallet behind an old-style injected provider, from the flag it sets. */
export function identifyInjected(provider: unknown): KnownWallet | null {
  if (typeof provider !== 'object' || provider === null) return null;
  const flags = provider as Record<string, unknown>;
  const others = KNOWN_WALLETS.filter((k) => k.key !== 'metamask');
  return others.find((k) => flags[k.flag] === true) ?? (flags['isMetaMask'] === true ? KNOWN_WALLETS[0]! : null);
}
