import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KNOWN_WALLETS, MORE_WALLETS, WALLETCONNECT_LOGO, identifyInjected, knownWallet, walletLogoUrl } from '../src/lib/wallet-logos';

describe('wallet logos', () => {
  it('has a logo file for every known wallet, and for WalletConnect', () => {
    for (const url of [...KNOWN_WALLETS.map((w) => walletLogoUrl(w.key)), WALLETCONNECT_LOGO]) {
      expect(existsSync(join(__dirname, '..', 'public', url)), url).toBe(true);
    }
  });

  it('knows an announced wallet by its rdns, or else by its name', () => {
    expect(knownWallet({ rdns: 'app.phantom', name: 'Anything' })?.key).toBe('phantom');
    expect(knownWallet({ name: 'metamask' })?.key).toBe('metamask');
    expect(knownWallet({ rdns: 'xyz.unknown', name: 'Some Wallet' })).toBeNull();
  });

  it('tells an injected wallet by its flag, with MetaMask last since others also claim to be it', () => {
    expect(identifyInjected({ isRabby: true, isMetaMask: true })?.key).toBe('rabby');
    expect(identifyInjected({ isMetaMask: true })?.key).toBe('metamask');
    expect(identifyInjected({ request() {} })).toBeNull();
    expect(identifyInjected(null)).toBeNull();
  });

  it('offers only wallets with an official site under "More wallets"', () => {
    expect(MORE_WALLETS.map((w) => w.name)).toEqual(['MetaMask', 'Rabby', 'Coinbase Wallet', 'Rainbow']);
    expect(MORE_WALLETS.every((w) => w.url?.startsWith('https://'))).toBe(true);
  });
});
