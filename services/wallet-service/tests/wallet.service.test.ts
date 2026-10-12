import { describe, expect, it } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import {
  WalletService,
  WalletAddressCollisionError,
  WalletNotFoundError,
  InvalidPrivateKeyError,
  WalletDeletionRefusedError,
  type WalletDeletionCheck,
  type WalletDeletionChecker,
} from '../src/service/wallet.service.js';
import type { UserId } from '../src/types/user-id.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';

// The one legitimate test-only cast to UserId (ADR-002 §3.3: real callers never construct one this
// way, only via a resolved identity).
const TEST_OWNER_ID = 'test-owner' as UserId;
const OTHER_OWNER_ID = 'other-owner' as UserId;

function makeService() {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletKeyService = new WalletKeyService(kms);
  const service = new WalletService(repository, walletKeyService, kms.keyId);
  return { service, repository };
}

describe('WalletService', () => {
  it('creates a wallet with a generated keypair and never exposes key material', async () => {
    const { service } = makeService();

    const wallet = await service.createWallet({ label: 'Test wallet', tier: 'HOT' }, TEST_OWNER_ID);

    expect(wallet.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(wallet.label).toBe('Test wallet');
    expect(wallet.tier).toBe('HOT');
    expect(wallet.status).toBe('ACTIVE');
    expect(wallet.keyVersion).toBe(1);
    // Structural guarantee: these keys must not exist on the returned object at all.
    expect(wallet).not.toHaveProperty('encryptedPrivateKey');
    expect(wallet).not.toHaveProperty('wrappedDek');
    expect(wallet).not.toHaveProperty('iv');
    expect(wallet).not.toHaveProperty('authTag');
  });

  it('imports a wallet from a known private key and derives the correct address', async () => {
    const { service } = makeService();
    const privateKey = generatePrivateKey();
    const { privateKeyToAccount } = await import('viem/accounts');
    const expectedAddress = privateKeyToAccount(privateKey).address.toLowerCase();

    const wallet = await service.importWallet({ privateKey, tier: 'TREASURY' }, TEST_OWNER_ID);

    expect(wallet.address).toBe(expectedAddress);
    expect(wallet.tier).toBe('TREASURY');
  });

  it('rejects an out-of-curve-range private key (0x00...00) with a clean InvalidPrivateKeyError, not viem\'s own error (which embeds the key\'s decimal value)', async () => {
    const { service } = makeService();
    const zeroKey = ('0x' + '00'.repeat(32)) as `0x${string}`;

    const err = await service.importWallet({ privateKey: zeroKey, tier: 'HOT' }, TEST_OWNER_ID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InvalidPrivateKeyError);
    expect((err as Error).message).not.toContain(zeroKey);
    expect((err as Error).message).not.toMatch(/got 0\b/);
    expect((err as Error).message).not.toMatch(/expected valid private key/);
  });

  it('rejects a private key at the curve order n (also out of range) the same clean way', async () => {
    const { service } = makeService();
    const tooLarge = '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141' as const;

    const err = await service.importWallet({ privateKey: tooLarge, tier: 'HOT' }, TEST_OWNER_ID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InvalidPrivateKeyError);
    expect((err as Error).message).not.toContain(tooLarge);
  });

  it('rejects importing a private key that maps to an already-registered address', async () => {
    const { service } = makeService();
    const privateKey = generatePrivateKey();

    await service.importWallet({ privateKey, tier: 'HOT' }, TEST_OWNER_ID);

    await expect(service.importWallet({ privateKey, tier: 'HOT' }, TEST_OWNER_ID)).rejects.toThrow(
      WalletAddressCollisionError,
    );
  });

  it('rejects importing a private key already registered to a DIFFERENT owner too', async () => {
    // ADR-002 §3.3: the collision check is global, not scoped to the caller, otherwise a second user
    // could "import" a first user's wallet.
    const { service } = makeService();
    const privateKey = generatePrivateKey();

    await service.importWallet({ privateKey, tier: 'HOT' }, TEST_OWNER_ID);

    await expect(service.importWallet({ privateKey, tier: 'HOT' }, OTHER_OWNER_ID)).rejects.toThrow(
      WalletAddressCollisionError,
    );
  });

  it('throws WalletNotFoundError for an unknown id', async () => {
    const { service } = makeService();
    await expect(service.getWalletSummary(TEST_OWNER_ID, 'does-not-exist')).rejects.toThrow(WalletNotFoundError);
  });

  it('throws WalletNotFoundError when the wallet belongs to a different owner', async () => {
    // A real wallet id looked up under the wrong owner must behave exactly like one that does not
    // exist.
    const { service } = makeService();
    const created = await service.createWallet({ tier: 'HOT' }, TEST_OWNER_ID);

    await expect(service.getWalletSummary(OTHER_OWNER_ID, created.id)).rejects.toThrow(WalletNotFoundError);
  });

  it('rotates a wallet key: increments version, changes ciphertext, address unchanged', async () => {
    const { service, repository } = makeService();
    const created = await service.createWallet({ tier: 'HOT' }, TEST_OWNER_ID);

    const recordBefore = await repository.findById(TEST_OWNER_ID, created.id);
    const rotated = await service.rotateWalletKey(TEST_OWNER_ID, created.id);
    const recordAfter = await repository.findById(TEST_OWNER_ID, created.id);

    expect(rotated.keyVersion).toBe(2);
    expect(rotated.address).toBe(created.address);
    expect(recordAfter!.encryptedPrivateKey).not.toBe(recordBefore!.encryptedPrivateKey);
    expect(recordAfter!.wrappedDek).not.toBe(recordBefore!.wrappedDek);
  });

  it('lists wallets filtered by tier, scoped to the caller', async () => {
    const { service } = makeService();
    await service.createWallet({ tier: 'HOT' }, TEST_OWNER_ID);
    await service.createWallet({ tier: 'TREASURY' }, TEST_OWNER_ID);
    await service.createWallet({ tier: 'HOT' }, TEST_OWNER_ID);
    await service.createWallet({ tier: 'HOT' }, OTHER_OWNER_ID); // must not show up below

    const hotWallets = await service.listWallets(TEST_OWNER_ID, { tier: 'HOT' });
    expect(hotWallets).toHaveLength(2);
    expect(hotWallets.every((w) => w.tier === 'HOT')).toBe(true);
  });
});

describe('WalletService: bulk generation', () => {
  it('generates the requested count of wallets, each with its own real keypair', async () => {
    const { service } = makeService();
    const wallets = await service.createWallets({ count: 3, tier: 'HOT' }, TEST_OWNER_ID);

    expect(wallets).toHaveLength(3);
    const addresses = new Set(wallets.map((w) => w.address));
    expect(addresses.size).toBe(3); // every address is distinct: real, separate keys
    for (const w of wallets) {
      expect(w.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(w.origin).toBe('GENERATED');
      expect(w.tier).toBe('HOT');
      expect(w).not.toHaveProperty('encryptedPrivateKey');
    }
  });

  it('numbers labels 01, 02, ... when a prefix is given', async () => {
    const { service } = makeService();
    const wallets = await service.createWallets({ count: 3, labelPrefix: 'Mint', tier: 'HOT' }, TEST_OWNER_ID);
    expect(wallets.map((w) => w.label)).toEqual(['Mint-01', 'Mint-02', 'Mint-03']);
  });

  it('pads past 9 without breaking the ordering (Mint-10, not Mint-010 or Mint-1)', async () => {
    const { service } = makeService();
    const wallets = await service.createWallets({ count: 10, labelPrefix: 'Mint', tier: 'HOT' }, TEST_OWNER_ID);
    expect(wallets[8]!.label).toBe('Mint-09');
    expect(wallets[9]!.label).toBe('Mint-10');
  });

  it('falls back to a generated readable name per wallet when no prefix is given', async () => {
    const { service } = makeService();
    const wallets = await service.createWallets({ count: 2, tier: 'HOT' }, TEST_OWNER_ID);
    for (const w of wallets) {
      expect(w.label).toMatch(/^[a-z]+-[a-z]+$/);
    }
  });

  it('persists every generated wallet, visible via listWallets', async () => {
    const { service } = makeService();
    await service.createWallets({ count: 4, tier: 'HOT' }, TEST_OWNER_ID);
    const listed = await service.listWallets(TEST_OWNER_ID);
    expect(listed).toHaveLength(4);
  });
});

describe('archive and permanent delete', () => {
  const check = (over: Partial<WalletDeletionCheck>): WalletDeletionCheck => ({ canDelete: true, reason: 'empty', message: 'Nothing on any chain.', funds: [], keyElsewhere: null, scheduled: 0, ...over });
  const noFunds: WalletDeletionChecker = async () => check({});
  const hasFunds: WalletDeletionChecker = async () => check({ canDelete: false, reason: 'has_funds', message: 'This wallet still holds 0.5 on Base.', funds: [{ chainName: 'Base', amount: '0.5' }] });

  it('archives a wallet without touching key material', async () => {
    const { service } = makeService();
    const created = await service.createWallet({ tier: 'HOT' }, TEST_OWNER_ID);

    const archived = await service.archiveWallet(TEST_OWNER_ID, created.id);
    expect(archived.status).toBe('ARCHIVED');

    // Still retrievable: archive is reversible, not destructive.
    const restored = await service.unarchiveWallet(TEST_OWNER_ID, created.id);
    expect(restored.status).toBe('ACTIVE');
  });

  it('deletes an active wallet too: archiving first is not required', async () => {
    const { service } = makeService();
    const created = await service.createWallet({ tier: 'HOT' }, TEST_OWNER_ID);
    await service.deleteWalletPermanently(TEST_OWNER_ID, created.id, noFunds);
    await expect(service.getWalletSummary(TEST_OWNER_ID, created.id)).rejects.toThrow();
  });

  it('passes the wallet and the key confirmation to the checker, and reports its answer', async () => {
    const { service } = makeService();
    const created = await service.createWallet({ tier: 'HOT' }, TEST_OWNER_ID);
    const seen: unknown[] = [];
    const checker: WalletDeletionChecker = async (wallet, opts) => {
      seen.push({ origin: wallet.origin, keySaved: opts.keySaved });
      return check({ canDelete: opts.keySaved, reason: opts.keySaved ? 'key_elsewhere' : 'confirm_key', message: 'Confirm you have the key.' });
    };
    expect((await service.deletionCheck(TEST_OWNER_ID, created.id, checker)).reason).toBe('confirm_key');
    await expect(service.deleteWalletPermanently(TEST_OWNER_ID, created.id, checker)).rejects.toBeInstanceOf(WalletDeletionRefusedError);
    await service.deleteWalletPermanently(TEST_OWNER_ID, created.id, checker, { keySaved: true });
    expect(seen).toEqual([{ origin: 'GENERATED', keySaved: false }, { origin: 'GENERATED', keySaved: false }, { origin: 'GENERATED', keySaved: true }]);
  });

  it('refuses permanent delete when the wallet still holds funds', async () => {
    const { service } = makeService();
    const created = await service.createWallet({ tier: 'HOT' }, TEST_OWNER_ID);
    await service.archiveWallet(TEST_OWNER_ID, created.id);

    await expect(service.deleteWalletPermanently(TEST_OWNER_ID, created.id, hasFunds)).rejects.toThrow(
      /still holds 0.5 on Base/i,
    );
  });

  it('permanently deletes an archived, empty wallet', async () => {
    const { service } = makeService();
    const created = await service.createWallet({ tier: 'HOT' }, TEST_OWNER_ID);
    await service.archiveWallet(TEST_OWNER_ID, created.id);

    await service.deleteWalletPermanently(TEST_OWNER_ID, created.id, noFunds);

    // Gone for good.
    await expect(service.getWalletSummary(TEST_OWNER_ID, created.id)).rejects.toThrow();
  });

  it('cannot be used by a different owner to delete a wallet that isn\'t theirs', async () => {
    const { service } = makeService();
    const created = await service.createWallet({ tier: 'HOT' }, TEST_OWNER_ID);
    await service.archiveWallet(TEST_OWNER_ID, created.id);

    await expect(service.deleteWalletPermanently(OTHER_OWNER_ID, created.id, noFunds)).rejects.toThrow(
      WalletNotFoundError,
    );
    // Still there, untouched, for its real owner.
    await expect(service.getWalletSummary(TEST_OWNER_ID, created.id)).resolves.toBeDefined();
  });
});

describe('wallet naming', () => {
  it('gives every generated wallet a readable name by default', async () => {
    const { service } = makeService();
    const wallet = await service.createWallet({ tier: 'HOT' }, TEST_OWNER_ID);

    expect(wallet.label).toBeTruthy();
    // Two lowercase words joined by a hyphen, e.g. "amber-falcon".
    expect(wallet.label).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('respects an explicitly supplied label over the generated one', async () => {
    const { service } = makeService();
    const wallet = await service.createWallet({ tier: 'HOT', label: 'My main wallet' }, TEST_OWNER_ID);
    expect(wallet.label).toBe('My main wallet');
  });

  it('renames a wallet', async () => {
    const { service } = makeService();
    const created = await service.createWallet({ tier: 'HOT' }, TEST_OWNER_ID);

    const renamed = await service.renameWallet(TEST_OWNER_ID, created.id, 'gas-funder');
    expect(renamed.label).toBe('gas-funder');
  });

  it('clears a label when renamed to null', async () => {
    const { service } = makeService();
    const created = await service.createWallet({ tier: 'HOT' }, TEST_OWNER_ID);

    const cleared = await service.renameWallet(TEST_OWNER_ID, created.id, null);
    expect(cleared.label).toBeNull();
  });
});

describe('WalletService: origin (GENERATED | IMPORTED), how Stryx came to hold the key', () => {
  it('createWallet marks the wallet GENERATED', async () => {
    const { service } = makeService();
    const wallet = await service.createWallet({ tier: 'HOT' }, TEST_OWNER_ID);
    expect(wallet.origin).toBe('GENERATED');
  });

  it('importWallet marks the wallet IMPORTED', async () => {
    const { service } = makeService();
    const wallet = await service.importWallet({ privateKey: generatePrivateKey(), tier: 'HOT' }, TEST_OWNER_ID);
    expect(wallet.origin).toBe('IMPORTED');
  });

  it.each(['TREASURY', 'HOT', 'MINT'] as const)(
    'origin is independent of tier: a %s wallet is GENERATED when created and IMPORTED when imported',
    async (tier) => {
      const { service } = makeService();

      const generated = await service.createWallet({ tier }, TEST_OWNER_ID);
      const imported = await service.importWallet({ privateKey: generatePrivateKey(), tier }, TEST_OWNER_ID);

      expect(generated.tier).toBe(tier);
      expect(generated.origin).toBe('GENERATED');
      expect(imported.tier).toBe(tier);
      expect(imported.origin).toBe('IMPORTED');
    },
  );

  it('is persisted and read back: getWalletSummary and listWallets report each wallet\'s own origin', async () => {
    const { service } = makeService();
    const generated = await service.createWallet({ tier: 'HOT' }, TEST_OWNER_ID);
    const imported = await service.importWallet({ privateKey: generatePrivateKey(), tier: 'HOT' }, TEST_OWNER_ID);

    expect((await service.getWalletSummary(TEST_OWNER_ID, generated.id)).origin).toBe('GENERATED');
    expect((await service.getWalletSummary(TEST_OWNER_ID, imported.id)).origin).toBe('IMPORTED');

    const byId = new Map((await service.listWallets(TEST_OWNER_ID)).map((w) => [w.id, w.origin]));
    expect(byId.get(generated.id)).toBe('GENERATED');
    expect(byId.get(imported.id)).toBe('IMPORTED');
  });

  it('does not change when the wallet is archived, restored, renamed or its key is rotated', async () => {
    const { service } = makeService();
    const imported = await service.importWallet({ privateKey: generatePrivateKey(), tier: 'HOT' }, TEST_OWNER_ID);

    expect((await service.archiveWallet(TEST_OWNER_ID, imported.id)).origin).toBe('IMPORTED');
    expect((await service.unarchiveWallet(TEST_OWNER_ID, imported.id)).origin).toBe('IMPORTED');
    expect((await service.renameWallet(TEST_OWNER_ID, imported.id, 'renamed')).origin).toBe('IMPORTED');
    expect((await service.rotateWalletKey(TEST_OWNER_ID, imported.id)).origin).toBe('IMPORTED');
  });

  it('exposing origin on the summary did not expose key material', async () => {
    const { service } = makeService();
    const wallet = await service.importWallet({ privateKey: generatePrivateKey(), tier: 'HOT' }, TEST_OWNER_ID);

    expect(wallet).toHaveProperty('origin');
    for (const field of ['encryptedPrivateKey', 'wrappedDek', 'iv', 'authTag']) {
      expect(wallet).not.toHaveProperty(field);
    }
  });
});
