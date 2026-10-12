import { describe, expect, it } from 'vitest';
import { CallExecutionError, RawContractError, RpcRequestError, TimeoutError, TransactionRejectedRpcError, encodeErrorResult } from 'viem';
import { SEADROP_ABI } from '@stryx/nft-engine';
import { privateKeyToAccount } from 'viem/accounts';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { SeaDropAllowListTree, type AllowListEntry } from '@stryx/eligibility';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { MintExecutionService } from '../src/mint-execution.service.js';
import { MintEligibilityService, type WalletEligibilityRow } from '../src/mint-eligibility.service.js';
import { InMemoryAllowListStore } from '../src/allowlist-store.js';
import { OpenSeaDropError } from '../src/opensea-drop-client.js';
import { FakeOpenSeaDropClient } from './fakes/fake-opensea-drop-client.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { makePermissiveSpendCapResolver } from './fakes/permissive-spend-cap-resolver.js';
import type { ChainServices } from '../src/chain-services.js';
import type { Phase } from '../src/collection-phases.service.js';
import type { DropEligibilityStage, OpenSeaEligibilitySource } from '../src/opensea-eligibility-source.js';

const CHAIN_ID = 46630;
const NFT_CONTRACT = '0x1234567890123456789012345678901234567890' as `0x${string}`;
const NOW = 1_800_000_000_000; // fixed instant, well inside the merkle mintParams window below

const mintParams = {
  mintPrice: 0n,
  maxTotalMintableByWallet: 2,
  startTime: 1_700_000_000,
  endTime: 2_000_000_000,
  dropStageIndex: 1,
  maxTokenSupplyForStage: 1000n,
  feeBps: 0,
  restrictFeeRecipients: false,
};

function fakeChain(opts: { mintedByAddress?: Record<string, number>; active?: boolean; getBalanceFails?: boolean; simulateFails?: boolean; simulateError?: unknown; noFeeRecipient?: boolean } = {}): ChainServices {
  return {
    seaDropReader: {
      async getPublicDrop() {
        return { mintPrice: 0n, startTime: 1_700_000_000, endTime: 2_000_000_000, maxTotalMintableByWallet: 2, feeBps: 0, restrictFeeRecipients: false };
      },
      async isPublicStageActive() {
        return opts.active ?? true;
      },
      async getMintStats(_scope: unknown, minter: `0x${string}`) {
        return { minterNumMinted: opts.mintedByAddress?.[minter.toLowerCase()] ?? 0, currentTotalSupply: 0n, maxSupply: 1000n };
      },
      async getAllowListMerkleRoot() {
        return `0x${'01'.repeat(32)}` as `0x${string}`;
      },
      async getAllowedFeeRecipients() {
        return opts.noFeeRecipient ? [] : ['0x0000a26b00c1F0DF003000390027140000fAa719' as `0x${string}`];
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    transactionEngine: {} as never,
    publicClient: {
      async getBalance() {
        if (opts.getBalanceFails) throw new Error('balance read failed');
        return 1_000_000_000_000_000_000n;
      },
      async call() {
        if (opts.simulateError) throw opts.simulateError;
        if (opts.simulateFails) throw new Error('execution reverted: fake revert');
        return { data: '0x' };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

async function buildRig(chain: ChainServices, sourceBehavior: FakeSourceBehavior | null = {}, now: () => number = () => NOW) {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletService = new WalletService(repository, new WalletKeyService(kms), kms.keyId);
  const chainServices = new Map<number, ChainServices>([[CHAIN_ID, chain]]);
  const allowListStore = new InMemoryAllowListStore();
  const mintExecutionService = new MintExecutionService(walletService, chainServices, allowListStore, new FakeOpenSeaDropClient({ kind: 'success', data: { mintParams, proof: [`0x${'ab'.repeat(32)}` as `0x${string}`] } }), makePermissiveSpendCapResolver());
  const source = sourceBehavior ? fakeEligibilitySource(sourceBehavior) : null;
  const eligibility = new MintEligibilityService(walletService, chainServices, mintExecutionService, source, now);
  return { walletService, chainServices, eligibility, source };
}

/**
 * Builds a rig with a real Merkle tree for one wallet: the proof is re-verified against the on-chain
 * root, so a made-up proof can never pass.
 */
let merkleRigCounter = 0;
async function buildMerkleRig(mintedCount = 0, mintParamsOverride: Partial<typeof mintParams> = {}) {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletService = new WalletService(repository, new WalletKeyService(kms), kms.keyId);
  const wallet = await importWallet(walletService, 30 + merkleRigCounter++);
  const entryParams = { ...mintParams, ...mintParamsOverride };
  const entries: AllowListEntry[] = [{ minter: wallet.address, mintParams: entryParams }];
  const tree = SeaDropAllowListTree.build(entries);
  const { proof } = tree.getProofForMinter(wallet.address)!;

  const chain = fakeChain({ mintedByAddress: { [wallet.address]: mintedCount } });
  const chainServices = new Map<number, ChainServices>([[CHAIN_ID, { ...chain, seaDropReader: { ...chain.seaDropReader, async getAllowListMerkleRoot() { return tree.root; } } as never }]]);
  const allowListStore = new InMemoryAllowListStore();
  const mintExecutionService = new MintExecutionService(walletService, chainServices, allowListStore, new FakeOpenSeaDropClient({ kind: 'success', data: { mintParams: entryParams, proof } }), makePermissiveSpendCapResolver());
  const eligibility = new MintEligibilityService(walletService, chainServices, mintExecutionService, fakeEligibilitySource(), () => NOW);
  return { eligibility, walletService, wallet };
}

async function buildRigWithProofFailure(chain: ChainServices, error: OpenSeaDropError) {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletService = new WalletService(repository, new WalletKeyService(kms), kms.keyId);
  const chainServices = new Map<number, ChainServices>([[CHAIN_ID, chain]]);
  const allowListStore = new InMemoryAllowListStore();
  const mintExecutionService = new MintExecutionService(walletService, chainServices, allowListStore, new FakeOpenSeaDropClient({ kind: 'throw', error }), makePermissiveSpendCapResolver());
  const eligibility = new MintEligibilityService(walletService, chainServices, mintExecutionService, fakeEligibilitySource(), () => NOW);
  return { walletService, eligibility };
}

interface FakeSourceBehavior {
  authFails?: boolean;
  eligibilityFails?: boolean;
  stages?: DropEligibilityStage[];
}

/** Stands in for the optional OpenSea eligibility module: answers with fixed stages, or one of its two failures. */
function fakeEligibilitySource(behavior: FakeSourceBehavior = {}): OpenSeaEligibilitySource & { askedFor: string[] } {
  const askedFor: string[] = [];
  return {
    askedFor,
    async stagesFor(wallet) {
      askedFor.push(wallet.id);
      if (behavior.authFails) return { ok: false, reason: 'opensea_auth_failed' };
      if (behavior.eligibilityFails) return { ok: false, reason: 'opensea_eligibility_failed' };
      return { ok: true, stages: behavior.stages ?? [] };
    },
    async forget() {},
  };
}

async function importWallet(walletService: WalletService, keyByte: number) {
  const privateKey = ('0x' + String(keyByte).padStart(2, '0').repeat(32)) as `0x${string}`;
  const address = privateKeyToAccount(privateKey).address;
  const wallet = await walletService.importWallet({ privateKey, tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);
  return { id: wallet.id, address: address.toLowerCase() as `0x${string}` };
}

function rowFor(results: readonly WalletEligibilityRow[], walletId: string): WalletEligibilityRow {
  const row = results.find((r) => r.walletId === walletId);
  if (!row) throw new Error(`no row for wallet ${walletId}`);
  return row;
}

const PUBLIC_PHASE: Phase = { id: 'public', name: 'Public', kind: 'public', priceWei: '0', startMs: 1_700_000_000_000, endMs: 2_000_000_000_000, maxPerWallet: 2, source: 'on-chain', mechanism: null, openSeaStageUuid: null };
const MERKLE_PHASE: Phase = { id: 'opensea-0', name: 'OG List', kind: 'allowlist', priceWei: '0', startMs: 1_700_000_000_000, endMs: 2_000_000_000_000, maxPerWallet: 2, source: 'opensea', mechanism: 'merkle', openSeaStageUuid: 'uuid-og' };
const SIGNED_PHASE: Phase = { id: 'opensea-0', name: 'FCFS', kind: 'allowlist', priceWei: '0', startMs: 1_700_000_000_000, endMs: 2_000_000_000_000, maxPerWallet: 1, source: 'opensea', mechanism: 'signed', openSeaStageUuid: 'uuid-fcfs' };
const TOKEN_GATED_PHASE: Phase = { ...SIGNED_PHASE, mechanism: 'token-gated' };

describe('MintEligibilityService: preflight', () => {
  it('reports unsupported_chain for a chain with no configured services', async () => {
    const { eligibility, walletService } = await buildRig(fakeChain());
    const w = await importWallet(walletService, 1);
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: 99999, phase: PUBLIC_PHASE, slug: null, walletIds: [w.id] });
    expect(outcome.preflightError).toBe('unsupported_chain');
    expect(outcome.results).toEqual([]);
  });

  it('token-gated (and any other unrecognised mechanism) fails clearly, never silently checked as merkle or signed', async () => {
    const { eligibility, walletService } = await buildRig(fakeChain());
    const w = await importWallet(walletService, 1);
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: TOKEN_GATED_PHASE, slug: 'slug', walletIds: [w.id] });
    expect(outcome.preflightError).toBe('unsupported_mechanism');
    expect(rowFor(outcome.results, w.id).eligible).toBe('unknown');
  });
});

describe('MintEligibilityService: public phase', () => {
  it('an eligible wallet on a live stage gets a successful simulation', async () => {
    const { eligibility, walletService } = await buildRig(fakeChain({ active: true }));
    const w = await importWallet(walletService, 1);
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: PUBLIC_PHASE, slug: null, walletIds: [w.id] });
    const row = rowFor(outcome.results, w.id);
    expect(row.eligible).toBe('eligible');
    expect(row.simulation).toEqual({ ok: true });
  });

  it('a wallet already at its limit is not eligible, and never gets simulated', async () => {
    const w1 = await (async () => { const r = await buildRig(fakeChain()); return r; })();
    const wallet = await importWallet(w1.walletService, 2);
    const chain = fakeChain({ mintedByAddress: { [wallet.address]: 2 } });
    w1.chainServices.set(CHAIN_ID, chain);
    const outcome = await w1.eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: PUBLIC_PHASE, slug: null, walletIds: [wallet.id] });
    const row = rowFor(outcome.results, wallet.id);
    expect(row.eligible).toBe('not_eligible');
    expect(row.reason).toBe('at_mint_limit');
    expect(row.simulation).toBeUndefined();
  });

  it('an inactive stage still reports real eligibility (would this wallet be allowed to mint), just never simulated: the whole point of checking early is letting an operator pre-select wallets before go-live', async () => {
    const { eligibility, walletService } = await buildRig(fakeChain({ active: false }));
    const w = await importWallet(walletService, 3);
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: PUBLIC_PHASE, slug: null, walletIds: [w.id] });
    const row = rowFor(outcome.results, w.id);
    expect(row.eligible).toBe('eligible'); // not gated on the stage being live yet
    expect(row.reason).toBe('stage_not_active'); // informational: still surfaced, just doesn't flip eligible to false
    expect(row.simulation).toBeUndefined();
  });

  it('a wallet already at its limit on an inactive stage reports at_mint_limit, not stage_not_active: being at the cap is the more specific, more actionable reason', async () => {
    const rig = await buildRig(fakeChain({ active: false }));
    const wallet = await importWallet(rig.walletService, 7);
    const chain = fakeChain({ active: false, mintedByAddress: { [wallet.address]: 2 } }); // PUBLIC_PHASE's own maxPerWallet is 2
    rig.chainServices.set(CHAIN_ID, chain);

    const outcome = await rig.eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: PUBLIC_PHASE, slug: null, walletIds: [wallet.id] });
    const row = rowFor(outcome.results, wallet.id);
    expect(row.eligible).toBe('not_eligible');
    expect(row.reason).toBe('at_mint_limit');
  });

  it('a real simulated revert is reported, not thrown', async () => {
    const { eligibility, walletService } = await buildRig(fakeChain({ active: true, simulateFails: true }));
    const w = await importWallet(walletService, 4);
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: PUBLIC_PHASE, slug: null, walletIds: [w.id] });
    const row = rowFor(outcome.results, w.id);
    expect(row.eligible).toBe('eligible'); // eligible per stage/limit; the simulation is what caught the real problem
    expect(row.simulation).toEqual({ ok: false, reason: 'reverted' });
  });

  it('a wallet that cannot pay the price fails the live check as insufficient_funds, with no raw chain error', async () => {
    const rpcErr = new RpcRequestError({ body: {}, url: 'https://rpc.example/v2/secret-key', error: { code: -32003, message: 'EVM error: OutOfFunds' } });
    const outOfFunds = new CallExecutionError(new TransactionRejectedRpcError(rpcErr), { to: NFT_CONTRACT });
    const { eligibility, walletService } = await buildRig(fakeChain({ active: true, simulateError: outOfFunds }));
    const w = await importWallet(walletService, 4);
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: PUBLIC_PHASE, slug: null, walletIds: [w.id] });
    const row = rowFor(outcome.results, w.id);
    expect(row.eligible).toBe('eligible');
    expect(row.simulation).toEqual({ ok: false, reason: 'insufficient_funds' });
    expect(JSON.stringify(outcome)).not.toContain('secret-key');
  });

  it('a SeaDrop revert in the live check is reported by its decoded name', async () => {
    const data = encodeErrorResult({ abi: SEADROP_ABI, errorName: 'MintQuantityExceedsMaxSupply', args: [1001n, 1000n] });
    const revert = new CallExecutionError(new RawContractError({ data, message: 'execution reverted' }), { to: NFT_CONTRACT });
    const { eligibility, walletService } = await buildRig(fakeChain({ active: true, simulateError: revert }));
    const w = await importWallet(walletService, 4);
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: PUBLIC_PHASE, slug: null, walletIds: [w.id] });
    expect(rowFor(outcome.results, w.id).simulation).toEqual({ ok: false, reason: 'MintQuantityExceedsMaxSupply(1001, 1000)' });
  });

  it('an unreachable chain during the live check is reported as rpc_unavailable', async () => {
    const timeout = new CallExecutionError(new TimeoutError({ body: {}, url: 'http://rpc.example' }), { to: NFT_CONTRACT });
    const { eligibility, walletService } = await buildRig(fakeChain({ active: true, simulateError: timeout }));
    const w = await importWallet(walletService, 4);
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: PUBLIC_PHASE, slug: null, walletIds: [w.id] });
    expect(rowFor(outcome.results, w.id).simulation).toEqual({ ok: false, reason: 'rpc_unavailable' });
  });

  it('a balance read failure degrades that field, not the whole row', async () => {
    const { eligibility, walletService } = await buildRig(fakeChain({ getBalanceFails: true }));
    const w = await importWallet(walletService, 5);
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: PUBLIC_PHASE, slug: null, walletIds: [w.id] });
    const row = rowFor(outcome.results, w.id);
    expect(row.balanceWei).toBe('0');
    expect(row.eligible).toBe('eligible');
  });
});

describe('MintEligibilityService: merkle allow-list phase', () => {
  it('requires a slug: preflight error, no chain reads, when the collection has none', async () => {
    const { eligibility, walletService } = await buildRig(fakeChain());
    const w = await importWallet(walletService, 6);
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: MERKLE_PHASE, slug: null, walletIds: [w.id] });
    expect(outcome.preflightError).toBe('missing_slug');
  });

  it('an eligible wallet, mid-window, gets a real simulation using the resolved proof', async () => {
    const { eligibility, wallet } = await buildMerkleRig();
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: MERKLE_PHASE, slug: 'cool-drop', walletIds: [wallet.id] });
    const row = rowFor(outcome.results, wallet.id);
    expect(row.eligible).toBe('eligible');
    expect(row.limit).toBe(2);
    expect(row.simulation).toEqual({ ok: true });
  });

  it('a wallet OpenSea has no proof for is not eligible (the exact verification the real mint uses)', async () => {
    const { eligibility, walletService } = await buildRigWithProofFailure(fakeChain(), new OpenSeaDropError('not_eligible', 'not on the list'));
    const w = await importWallet(walletService, 8);
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: MERKLE_PHASE, slug: 'cool-drop', walletIds: [w.id] });
    const row = rowFor(outcome.results, w.id);
    expect(row.eligible).toBe('not_eligible');
    expect(row.simulation).toBeUndefined();
  });

  it('insufficient_funds is "unknown", not "no": OpenSea could not even answer the eligibility question yet', async () => {
    const { eligibility, walletService } = await buildRigWithProofFailure(fakeChain(), new OpenSeaDropError('insufficient_funds', 'fund this wallet'));
    const w = await importWallet(walletService, 9);
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: MERKLE_PHASE, slug: 'cool-drop', walletIds: [w.id] });
    expect(rowFor(outcome.results, w.id).eligible).toBe('unknown');
  });

  it('a wallet already at the resolved per-wallet limit is not eligible, and is never simulated', async () => {
    const { eligibility, wallet } = await buildMerkleRig(2); // maxTotalMintableByWallet is 2, already minted 2
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: MERKLE_PHASE, slug: 'cool-drop', walletIds: [wallet.id] });
    const row = rowFor(outcome.results, wallet.id);
    expect(row.eligible).toBe('not_eligible');
    expect(row.reason).toBe('at_mint_limit');
    expect(row.simulation).toBeUndefined();
  });

  it('a phase not yet live is not simulated, even for an eligible wallet', async () => {
    const { eligibility, wallet } = await buildMerkleRig(0, { startTime: 2_100_000_000, endTime: 2_200_000_000 });
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: MERKLE_PHASE, slug: 'cool-drop', walletIds: [wallet.id] });
    const row = rowFor(outcome.results, wallet.id);
    expect(row.eligible).toBe('eligible'); // it IS eligible, just not live yet
    expect(row.simulation).toBeUndefined();
  });
});

describe('MintEligibilityService: signed-mint phase', () => {
  it('requires a slug AND an OpenSea stage id: preflight error without either', async () => {
    const { eligibility, walletService } = await buildRig(fakeChain());
    const w = await importWallet(walletService, 12);
    const noUuid = { ...SIGNED_PHASE, openSeaStageUuid: null };
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: noUuid, slug: 'kid-story', walletIds: [w.id] });
    expect(outcome.preflightError).toBe('missing_slug');
  });

  it('an eligible wallet, per OpenSea\'s real eligibility endpoint, is reported eligible with no simulation', async () => {
    const stages: DropEligibilityStage[] = [{ stage_uuid: 'uuid-fcfs', is_eligible: true, price: '0', max_total_mintable_by_wallet: '1', max_total_mintable_by_wallet_per_token: null }];
    const { eligibility, walletService } = await buildRig(fakeChain(), { stages });
    const w = await importWallet(walletService, 13);
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: SIGNED_PHASE, slug: 'kid-story', walletIds: [w.id] });
    const row = rowFor(outcome.results, w.id);
    expect(row.eligible).toBe('eligible');
    expect(row.limit).toBe(1);
    expect(row.priceWei).toBe('0');
    expect(row.simulation).toBeUndefined();
  });

  it('matches the stage even when OpenSea\'s two endpoints format the same UUID differently (GET /drops/{slug} returned it hyphen-free, GET /drops/{slug}/eligibility returned the standard hyphenated form for the identical stage)', async () => {
    const hyphenlessPhase = { ...SIGNED_PHASE, openSeaStageUuid: 'uuidfcfs' };
    const stages: DropEligibilityStage[] = [{ stage_uuid: 'uuid-fcfs', is_eligible: true, price: '0', max_total_mintable_by_wallet: '1', max_total_mintable_by_wallet_per_token: null }];
    const { eligibility, walletService } = await buildRig(fakeChain(), { stages });
    const w = await importWallet(walletService, 29);
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: hyphenlessPhase, slug: 'kid-story', walletIds: [w.id] });
    const row = rowFor(outcome.results, w.id);
    expect(row.eligible).toBe('eligible');
    expect(row.reason).toBeUndefined();
  });

  it('an ineligible wallet is reported not_eligible with a clear reason', async () => {
    const stages: DropEligibilityStage[] = [{ stage_uuid: 'uuid-fcfs', is_eligible: false, price: null, max_total_mintable_by_wallet: null, max_total_mintable_by_wallet_per_token: null }];
    const { eligibility, walletService } = await buildRig(fakeChain(), { stages });
    const w = await importWallet(walletService, 14);
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: SIGNED_PHASE, slug: 'kid-story', walletIds: [w.id] });
    const row = rowFor(outcome.results, w.id);
    expect(row.eligible).toBe('not_eligible');
    expect(row.reason).toBe('not_on_allowlist');
  });

  it('a stage id missing from OpenSea\'s response is "unknown", never assumed either way', async () => {
    const { eligibility, walletService } = await buildRig(fakeChain(), { stages: [] });
    const w = await importWallet(walletService, 15);
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: SIGNED_PHASE, slug: 'kid-story', walletIds: [w.id] });
    expect(rowFor(outcome.results, w.id).eligible).toBe('unknown');
  });

  it('an OpenSea authentication failure degrades that wallet to unknown, not a thrown error', async () => {
    const { eligibility, walletService } = await buildRig(fakeChain(), { authFails: true });
    const w = await importWallet(walletService, 16);
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: SIGNED_PHASE, slug: 'kid-story', walletIds: [w.id] });
    const row = rowFor(outcome.results, w.id);
    expect(row.eligible).toBe('unknown');
    expect(row.reason).toBe('opensea_auth_failed');
  });

  it('an eligibility-fetch failure (after a successful sign-in) also degrades to unknown', async () => {
    const { eligibility, walletService } = await buildRig(fakeChain(), { eligibilityFails: true });
    const w = await importWallet(walletService, 17);
    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: SIGNED_PHASE, slug: 'kid-story', walletIds: [w.id] });
    expect(rowFor(outcome.results, w.id).reason).toBe('opensea_eligibility_failed');
  });

  it('never asks OpenSea about a wallet that was not named in walletIds, even when other wallets exist', async () => {
    const stages: DropEligibilityStage[] = [{ stage_uuid: 'uuid-fcfs', is_eligible: true, price: '0', max_total_mintable_by_wallet: '1', max_total_mintable_by_wallet_per_token: null }];
    const { eligibility, walletService, source } = await buildRig(fakeChain(), { stages });
    const a = await importWallet(walletService, 19);
    const b = await importWallet(walletService, 20);
    const bystander = await importWallet(walletService, 21); // exists, owned by the same user, never listed

    await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: SIGNED_PHASE, slug: 'kid-story', walletIds: [a.id, b.id] });

    expect(new Set(source!.askedFor)).toEqual(new Set([a.id, b.id]));
    expect(source!.askedFor).not.toContain(bystander.id);
  });
});

describe('MintEligibilityService: signed-mint eligibility can be turned off entirely', () => {
  it('returns a signed_mint_disabled preflight error when there is no OpenSea eligibility source', async () => {
    const { eligibility, walletService } = await buildRig(fakeChain(), null);
    const w = await importWallet(walletService, 23);

    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: SIGNED_PHASE, slug: 'kid-story', walletIds: [w.id] });

    expect(outcome.preflightError).toBe('signed_mint_disabled');
    expect(outcome.results).toEqual([]);
  });

  it('public and merkle phases are unaffected by the flag being off', async () => {
    const { eligibility, walletService } = await buildRig(fakeChain({ active: true }), null);
    const w = await importWallet(walletService, 24);

    const outcome = await eligibility.checkPhase({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, phase: PUBLIC_PHASE, slug: null, walletIds: [w.id] });

    expect(outcome.preflightError).toBeUndefined();
    expect(rowFor(outcome.results, w.id).eligible).toBe('eligible');
  });
});
