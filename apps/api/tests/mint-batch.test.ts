import { describe, expect, it } from 'vitest';
import { TimeoutError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { BroadcastUncertainError, EmergencyStopActiveError, SimulationRevertedError } from '@stryx/transaction-engine';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { MintExecutionService } from '../src/mint-execution.service.js';
import { MintBatchService, MAX_BATCH_WALLETS, MAX_QUANTITY_PER_MINT, type WalletMintRow } from '../src/mint-batch.service.js';
import { InMemoryAllowListStore } from '../src/allowlist-store.js';
import { FakeOpenSeaDropClient } from './fakes/fake-opensea-drop-client.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { makePermissiveSpendCapResolver } from './fakes/permissive-spend-cap-resolver.js';
import type { ChainServices } from '../src/chain-services.js';

const CHAIN_ID = 46630;
const NFT_CONTRACT = '0x1234567890123456789012345678901234567890' as `0x${string}`;
const FEE_RECIPIENT = '0x0000a26b00c1F0DF003000390027140000fAa719' as `0x${string}`;

/** A per-wallet-address-configurable fake SeaDropReader + TransactionEngine. */
function fakeChain(opts: {
  publicDrop?: { mintPrice: bigint; startTime: number; endTime: number; maxTotalMintableByWallet: number; feeBps: number; restrictFeeRecipients: boolean };
  mintedByAddress?: Record<string, number>;
  behaviorByAddress?: Record<string, { hash: string } | Error>;
  onExecute?: (walletAddress: string, options: { priorityFeeWei?: bigint }) => void;
}): ChainServices {
  const publicDrop = opts.publicDrop ?? {
    mintPrice: 0n,
    startTime: 1_700_000_000,
    endTime: 2_000_000_000,
    maxTotalMintableByWallet: 10,
    feeBps: 0,
    restrictFeeRecipients: false,
  };

  const seaDropReader = {
    async getPublicDrop() {
      return publicDrop;
    },
    async isPublicStageActive() {
      return true;
    },
    async getAllowListMerkleRoot() {
      return `0x${'00'.repeat(32)}` as `0x${string}`;
    },
    async getAllowedFeeRecipients() {
      return [FEE_RECIPIENT];
    },
    async getMintStats(_scope: unknown, minter: `0x${string}`) {
      const minted = opts.mintedByAddress?.[minter.toLowerCase()] ?? 0;
      return { minterNumMinted: minted, currentTotalSupply: 0n, maxSupply: 1000n };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const transactionEngine = {
    async executeTransaction(scope: { walletAddress: string }, _tx: unknown, options?: { priorityFeeWei?: bigint }) {
      opts.onExecute?.(scope.walletAddress, options ?? {});
      const behavior = opts.behaviorByAddress?.[scope.walletAddress.toLowerCase()];
      if (behavior instanceof Error) throw behavior;
      return { hash: behavior?.hash ?? '0x' + '11'.repeat(32), nonce: 0, status: 'broadcast' };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { seaDropReader, transactionEngine, publicClient: {} as never };
}

async function buildRig(chain: ChainServices) {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletService = new WalletService(repository, new WalletKeyService(kms), kms.keyId);
  const chainServices = new Map<number, ChainServices>([[CHAIN_ID, chain]]);
  const mintExecutionService = new MintExecutionService(
    walletService,
    chainServices,
    new InMemoryAllowListStore(),
    new FakeOpenSeaDropClient(),
    makePermissiveSpendCapResolver(),
  );

  async function importWallet(keyByte: number) {
    const privateKey = ('0x' + String(keyByte).padStart(2, '0').repeat(32)) as `0x${string}`;
    const address = privateKeyToAccount(privateKey).address;
    const wallet = await walletService.importWallet({ privateKey, tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);
    return { id: wallet.id, address: address.toLowerCase() };
  }

  return { walletService, chainServices, mintExecutionService, importWallet };
}

function rowFor(results: readonly WalletMintRow[], walletId: string): WalletMintRow {
  const row = results.find((r) => r.walletId === walletId);
  if (!row) throw new Error(`no row for wallet ${walletId}`);
  return row;
}

describe('MintBatchService, the explicitly requested case: a multi-wallet batch where some succeed and some fail', () => {
  it('mints wallets independently: one reverting does not stop, hide, or misclassify the others', async () => {
    const A = { key: 1 };
    const B = { key: 2 }; // this one reverts
    const C = { key: 3 };
    const rig = await buildRig(fakeChain({}));
    const a = await rig.importWallet(A.key);
    const b = await rig.importWallet(B.key);
    const c = await rig.importWallet(C.key);

    const chain = fakeChain({
      behaviorByAddress: {
        [b.address]: new SimulationRevertedError({ chainId: CHAIN_ID, walletId: b.id, walletAddress: b.address, ownerId: RESERVED_OPERATOR_USER_ID, spendCapWei: null }, new Error('reverted')),
      },
    });
    rig.chainServices.set(CHAIN_ID, chain);
    const batch = new MintBatchService(rig.walletService, rig.chainServices, rig.mintExecutionService);

    const outcome = await batch.mint({
      ownerId: RESERVED_OPERATOR_USER_ID,
      nftContract: NFT_CONTRACT,
      chainId: CHAIN_ID,
      walletIds: [a.id, b.id, c.id],
      quantity: 1,
      stage: 'public',
    });

    expect(outcome.ok).toBe(false); // not every wallet succeeded
    expect(outcome.haltReason).toBeUndefined(); // a revert is wallet-specific, not systemic: the batch was NOT halted
    expect(outcome.results).toHaveLength(3);

    expect(rowFor(outcome.results, a.id).status).toBe('sent');
    expect(rowFor(outcome.results, c.id).status).toBe('sent'); // C ran despite B's revert: proof B didn't halt anything

    const bRow = rowFor(outcome.results, b.id);
    expect(bRow.status).toBe('failed');
    expect(bRow.reason).toBe('simulation_reverted'); // never misclassified as rpc_unavailable
  });
});

describe('MintBatchService: halting', () => {
  it('emergency stop mid-batch halts every NOT-YET-STARTED wallet, leaving them "skipped"', async () => {
    // poolSize=1 forces strict sequential processing, so which wallets had started when the stop fires
    // is deterministic.
    const rig = await buildRig(fakeChain({}));
    const a = await rig.importWallet(1);
    const b = await rig.importWallet(2); // this one trips the stop
    const c = await rig.importWallet(3); // must never be attempted

    const chain = fakeChain({
      behaviorByAddress: {
        [b.address]: new EmergencyStopActiveError({ chainId: CHAIN_ID, walletId: b.id, walletAddress: b.address, ownerId: RESERVED_OPERATOR_USER_ID, spendCapWei: null }, 'pre-sign'),
      },
    });
    rig.chainServices.set(CHAIN_ID, chain);
    const batch = new MintBatchService(rig.walletService, rig.chainServices, rig.mintExecutionService, 1);

    const outcome = await batch.mint({
      ownerId: RESERVED_OPERATOR_USER_ID,
      nftContract: NFT_CONTRACT,
      chainId: CHAIN_ID,
      walletIds: [a.id, b.id, c.id],
      quantity: 1,
      stage: 'public',
    });

    expect(outcome.haltReason).toBe('emergency_stop');
    expect(rowFor(outcome.results, a.id).status).toBe('sent'); // already running before the stop tripped
    expect(rowFor(outcome.results, b.id).status).toBe('failed');
    expect(rowFor(outcome.results, b.id).reason).toBe('emergency_stop');

    const cRow = rowFor(outcome.results, c.id);
    expect(cRow.status).toBe('skipped'); // never launched at all
    expect(cRow.quantity).toBe(0);
    expect(cRow.reason).toBe('emergency_stop');
  });
});

describe('MintBatchService: "max" quantity resolution', () => {
  it('resolves remaining = limit - already minted PER WALLET, and skips (never submits) a wallet already at its limit', async () => {
    const rig = await buildRig(fakeChain({}));
    const atLimit = await rig.importWallet(1); // minted 10 of a 10 limit
    const partial = await rig.importWallet(2); // minted 3 of 10 -> should mint 7

    const chain = fakeChain({ mintedByAddress: { [atLimit.address]: 10, [partial.address]: 3 } });
    rig.chainServices.set(CHAIN_ID, chain);
    const batch = new MintBatchService(rig.walletService, rig.chainServices, rig.mintExecutionService);

    const outcome = await batch.mint({
      ownerId: RESERVED_OPERATOR_USER_ID,
      nftContract: NFT_CONTRACT,
      chainId: CHAIN_ID,
      walletIds: [atLimit.id, partial.id],
      quantity: 'max',
      stage: 'public',
    });

    const atLimitRow = rowFor(outcome.results, atLimit.id);
    expect(atLimitRow.status).toBe('skipped');
    expect(atLimitRow.reason).toBe('at_mint_limit');
    expect(atLimitRow.quantity).toBe(0);

    const partialRow = rowFor(outcome.results, partial.id);
    expect(partialRow.status).toBe('sent');
    expect(partialRow.quantity).toBe(7); // 10 - 3
  });

  it('a real RPC transport failure while resolving "max" halts the whole batch and skips every wallet as rpc_unavailable', async () => {
    const rig = await buildRig(fakeChain({}));
    const a = await rig.importWallet(1);
    const b = await rig.importWallet(2);

    const chain = fakeChain({});
    chain.seaDropReader.getPublicDrop = async () => {
      throw new TimeoutError({ body: {}, url: 'https://rpc.example/v2/SECRET-API-KEY' });
    };
    rig.chainServices.set(CHAIN_ID, chain);
    const batch = new MintBatchService(rig.walletService, rig.chainServices, rig.mintExecutionService);

    const outcome = await batch.mint({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, walletIds: [a.id, b.id], quantity: 'max', stage: 'public' });

    expect(outcome.haltReason).toBe('rpc_unavailable');
    expect(outcome.results.every((r) => r.status === 'skipped')).toBe(true);
    // viem's own error text embeds the RPC URL: never surface it.
    expect(JSON.stringify(outcome.results)).not.toContain('SECRET-API-KEY');
  });

  it('a genuinely unexpected (non-RPC) failure while resolving "max" propagates rather than being silently treated as a halt', async () => {
    const rig = await buildRig(fakeChain({}));
    const a = await rig.importWallet(1);

    const chain = fakeChain({});
    chain.seaDropReader.getPublicDrop = async () => {
      throw new Error('something genuinely unexpected');
    };
    rig.chainServices.set(CHAIN_ID, chain);
    const batch = new MintBatchService(rig.walletService, rig.chainServices, rig.mintExecutionService);

    await expect(
      batch.mint({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, walletIds: [a.id], quantity: 'max', stage: 'public' }),
    ).rejects.toThrow('something genuinely unexpected');
  });
});

describe('MintBatchService: preflight rejections (nothing is attempted)', () => {
  it('refuses an empty wallet list', async () => {
    const rig = await buildRig(fakeChain({}));
    const batch = new MintBatchService(rig.walletService, rig.chainServices, rig.mintExecutionService);

    const outcome = await batch.mint({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, walletIds: [], quantity: 1, stage: 'public' });

    expect(outcome.preflightError).toBe('no_wallets');
  });

  it('refuses a duplicate wallet id', async () => {
    const rig = await buildRig(fakeChain({}));
    const a = await rig.importWallet(1);
    const batch = new MintBatchService(rig.walletService, rig.chainServices, rig.mintExecutionService);

    const outcome = await batch.mint({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, walletIds: [a.id, a.id], quantity: 1, stage: 'public' });

    expect(outcome.preflightError).toBe('duplicate_wallets');
  });

  it(`refuses more than ${MAX_BATCH_WALLETS} wallets`, async () => {
    const rig = await buildRig(fakeChain({}));
    const ids = Array.from({ length: MAX_BATCH_WALLETS + 1 }, (_, i) => `wallet-${i}`);
    const batch = new MintBatchService(rig.walletService, rig.chainServices, rig.mintExecutionService);

    const outcome = await batch.mint({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, walletIds: ids, quantity: 1, stage: 'public' });

    expect(outcome.preflightError).toBe('too_many_wallets');
  });

  it('refuses a chain with no RPC configured', async () => {
    const rig = await buildRig(fakeChain({}));
    const a = await rig.importWallet(1);
    const batch = new MintBatchService(rig.walletService, rig.chainServices, rig.mintExecutionService);

    const outcome = await batch.mint({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: 999_999, walletIds: [a.id], quantity: 1, stage: 'public' });

    expect(outcome.preflightError).toBe('unsupported_chain');
  });
});

describe('MintBatchService: priority fee', () => {
  it("passes the chosen tip to every wallet's send, and none when unset", async () => {
    const seen: Array<{ priorityFeeWei?: bigint }> = [];
    const rig = await buildRig(fakeChain({}));
    const a = await rig.importWallet(1);
    const b = await rig.importWallet(2);
    rig.chainServices.set(CHAIN_ID, fakeChain({ onExecute: (_addr, o) => seen.push(o) }));
    const batch = new MintBatchService(rig.walletService, rig.chainServices, rig.mintExecutionService);

    const base = { ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, walletIds: [a.id, b.id], quantity: 1, stage: 'public' } as const;
    await batch.mint({ ...base, priorityFeeWei: '3000000000' });
    expect(seen.map((o) => (o as { priorityFeeWei?: bigint }).priorityFeeWei)).toEqual([3_000_000_000n, 3_000_000_000n]);

    seen.length = 0;
    await batch.mint(base);
    expect(seen.map((o) => (o as { priorityFeeWei?: bigint }).priorityFeeWei)).toEqual([undefined, undefined]);
  });
});

describe('MintBatchService: chain without SeaDrop', () => {
  it('refuses every wallet with a plain reason and never builds or sends a transaction', async () => {
    let sends = 0;
    const rig = await buildRig(fakeChain({}));
    const a = await rig.importWallet(1);
    const chain = { ...fakeChain({ onExecute: () => sends++ }), seaDropSupport: { isDeployed: async () => false } } as unknown as ChainServices;
    rig.chainServices.set(CHAIN_ID, chain);
    const batch = new MintBatchService(rig.walletService, rig.chainServices, rig.mintExecutionService);
    const out = await batch.mint({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, walletIds: [a.id], quantity: 1, stage: 'public' });
    expect(out.results[0]).toMatchObject({ status: 'failed', reason: 'unsupported_chain' });
    expect(out.results[0]!.error ?? '').toMatch(/SeaDrop .* isn't deployed there/);
    expect(sends).toBe(0);
  });
});

describe('MintBatchService: a mint whose outcome is not known is never called failed', () => {
  const request = (walletIds: string[]) => ({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, walletIds, quantity: 1, stage: 'public' }) as const;

  it('a send the chain could not confirm either way is "unknown", with its hash', async () => {
    const rig = await buildRig(fakeChain({}));
    const a = await rig.importWallet(1);
    const hash = ('0x' + 'ee'.repeat(32)) as `0x${string}`;
    rig.chainServices.set(CHAIN_ID, fakeChain({ behaviorByAddress: { [a.address]: new BroadcastUncertainError({} as never, hash, 4, new Error('timeout')) } }));
    const batch = new MintBatchService(rig.walletService, rig.chainServices, rig.mintExecutionService);

    const out = await batch.mint(request([a.id]));

    expect(out.ok).toBe(false);
    expect(out.haltReason).toBeUndefined();
    expect(out.results[0]).toMatchObject({ status: 'unknown', reason: 'send_unconfirmed', hash, nonce: 4 });
    expect(out.results[0]!.error).toMatch(/May have been sent/);
  });

  it('a wallet that runs past the per-wallet time limit is "unknown": its mint is still running', async () => {
    const rig = await buildRig(fakeChain({}));
    const a = await rig.importWallet(1);
    let finished = false;
    const slow = fakeChain({});
    slow.transactionEngine.executeTransaction = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      finished = true;
      return { hash: '0x' + '11'.repeat(32), nonce: 0, status: 'broadcast' };
    }) as never;
    rig.chainServices.set(CHAIN_ID, slow);
    const batch = new MintBatchService(rig.walletService, rig.chainServices, rig.mintExecutionService, 4, 15);

    const out = await batch.mint(request([a.id]));

    expect(out.results[0]).toMatchObject({ status: 'unknown', reason: 'send_unconfirmed' });
    expect(finished).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(finished).toBe(true); // it did go out after the row was returned
  });
});

describe('MintBatchService: limits on what one mint may take', () => {
  it('"max" never asks for more than a typed quantity could', async () => {
    const quantities: number[] = [];
    const rig = await buildRig(fakeChain({}));
    const a = await rig.importWallet(1);
    const chain = fakeChain({ publicDrop: { mintPrice: 0n, startTime: 1_700_000_000, endTime: 2_000_000_000, maxTotalMintableByWallet: 10_000, feeBps: 0, restrictFeeRecipients: false } });
    rig.chainServices.set(CHAIN_ID, chain);
    const batch = new MintBatchService(rig.walletService, rig.chainServices, rig.mintExecutionService);

    const out = await batch.mint({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, walletIds: [a.id], quantity: 'max', stage: 'public' });
    quantities.push(out.results[0]!.quantity);

    expect(quantities).toEqual([MAX_QUANTITY_PER_MINT]);
  });

  it('a mint carrying a price ceiling is refused, unsent, once the price is above it', async () => {
    let sends = 0;
    const rig = await buildRig(fakeChain({}));
    const a = await rig.importWallet(1);
    const priced = { mintPrice: 500n, startTime: 1_700_000_000, endTime: 2_000_000_000, maxTotalMintableByWallet: 10, feeBps: 0, restrictFeeRecipients: false };
    rig.chainServices.set(CHAIN_ID, fakeChain({ publicDrop: priced, onExecute: () => sends++ }));
    const mint = (maxPriceWei: string) => rig.mintExecutionService.executePublicMint({ ownerId: RESERVED_OPERATOR_USER_ID, walletId: a.id, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, quantity: 2, maxPriceWei });

    expect(await mint('499')).toMatchObject({ ok: false, reason: 'price_above_limit' });
    expect(sends).toBe(0);
    expect(await mint('500')).toMatchObject({ ok: true });
    expect(sends).toBe(1);
  });
});
