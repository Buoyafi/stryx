import { describe, expect, it } from 'vitest';
import { listPhases } from '../src/collection-phases.service.js';
import type { ChainServices } from '../src/chain-services.js';
import type { OpenSeaDropInfo, OpenSeaStageInfo } from '../src/opensea-drop-info.js';

const CONTRACT = '0x1234567890123456789012345678901234567890' as const;

function fakeServices(publicDrop: { mintPrice: bigint; startTime: number; endTime: number; maxTotalMintableByWallet: number }): ChainServices {
  return {
    seaDropReader: {
      getPublicDrop: async () => ({ ...publicDrop, feeBps: 0, restrictFeeRecipients: false }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transactionEngine: {} as any,
  };
}

const NOT_CONFIGURED = { mintPrice: 0n, startTime: 0, endTime: 0, maxTotalMintableByWallet: 0 };
const CONFIGURED = { mintPrice: 10n ** 16n, startTime: 1_700_000_000, endTime: 1_800_000_000, maxTotalMintableByWallet: 5 };

function stage(overrides: Partial<OpenSeaStageInfo>): OpenSeaStageInfo {
  return { stageType: 'unknown', label: 'Stage', priceWei: null, startTime: null, endTime: null, maxPerWallet: null, allowlistWalletCount: null, uuid: null, ...overrides };
}

function dropInfo(stages: OpenSeaStageInfo[]): OpenSeaDropInfo {
  return { collectionSlug: 'x', collectionName: 'X', imageUrl: null, openSeaUrl: null, totalSupply: null, maxSupply: null, stages };
}

describe('listPhases: no OpenSea data', () => {
  it('a configured public stage becomes "Public", on-chain sourced, mechanism null (not an allow-list)', async () => {
    const phases = await listPhases(46630, CONTRACT, fakeServices(CONFIGURED), null);
    expect(phases).toEqual([
      { id: 'public', name: 'Public', kind: 'public', priceWei: (10n ** 16n).toString(), startMs: 1_700_000_000_000, endMs: 1_800_000_000_000, maxPerWallet: 5, source: 'on-chain', mechanism: null, openSeaStageUuid: null },
    ]);
  });

  it('an unconfigured public stage (startTime 0) yields no phases at all', async () => {
    const phases = await listPhases(46630, CONTRACT, fakeServices(NOT_CONFIGURED), null);
    expect(phases).toEqual([]);
  });
});

describe('listPhases: with OpenSea data', () => {
  it('names the public phase from OpenSea\'s public_sale label, keeps on-chain price/timing/max, carries its uuid', async () => {
    const info = dropInfo([stage({ stageType: 'public_sale', label: 'Public Mint', priceWei: '999999999999999999', maxPerWallet: 999, uuid: 'uuid-public' })]);
    const phases = await listPhases(46630, CONTRACT, fakeServices(CONFIGURED), info);
    expect(phases).toEqual([
      { id: 'public', name: 'Public Mint', kind: 'public', priceWei: (10n ** 16n).toString(), startMs: 1_700_000_000_000, endMs: 1_800_000_000_000, maxPerWallet: 5, source: 'on-chain', mechanism: null, openSeaStageUuid: 'uuid-public' },
    ]);
  });

  it('lists every allow-list phase OpenSea names, using OpenSea\'s own price/timing/max: none of it is on-chain verifiable without a wallet\'s proof', async () => {
    const info = dropInfo([
      stage({ stageType: 'public_sale', label: 'Public' }),
      stage({ stageType: 'presale', label: 'OG List', priceWei: '5000000000000000', startTime: '2026-09-16T19:30:00Z', endTime: '2026-10-16T19:30:00Z', maxPerWallet: 2, uuid: 'uuid-og' }),
      stage({ stageType: 'presale', label: 'Waitlist', priceWei: '10000000000000000', maxPerWallet: 1, uuid: 'uuid-wl' }),
    ]);
    const phases = await listPhases(46630, CONTRACT, fakeServices(CONFIGURED), info);
    expect(phases).toHaveLength(3);
    expect(phases[0]!.id).toBe('public');
    expect(phases[1]).toEqual({ id: 'opensea-1', name: 'OG List', kind: 'allowlist', priceWei: '5000000000000000', startMs: Date.parse('2026-09-16T19:30:00Z'), endMs: Date.parse('2026-10-16T19:30:00Z'), maxPerWallet: 2, source: 'opensea', mechanism: 'merkle', openSeaStageUuid: 'uuid-og' });
    expect(phases[2]).toEqual({ id: 'opensea-2', name: 'Waitlist', kind: 'allowlist', priceWei: '10000000000000000', startMs: null, endMs: null, maxPerWallet: 1, source: 'opensea', mechanism: 'merkle', openSeaStageUuid: 'uuid-wl' });
  });

  it('an on-chain-configured public stage with NO matching OpenSea public_sale entry still appears, named "Public"', async () => {
    const info = dropInfo([stage({ stageType: 'presale', label: 'Allowlist Only' })]);
    const phases = await listPhases(46630, CONTRACT, fakeServices(CONFIGURED), info);
    expect(phases.map((p) => p.id)).toEqual(['public', 'opensea-0']);
    expect(phases[0]!.name).toBe('Public');
    expect(phases[0]!.source).toBe('on-chain');
  });

  it('an OpenSea public_sale entry with no matching on-chain configuration is listed as its own opensea-sourced phase, not merged away', async () => {
    const info = dropInfo([stage({ stageType: 'public_sale', label: 'Stale Public', priceWei: '1' })]);
    const phases = await listPhases(46630, CONTRACT, fakeServices(NOT_CONFIGURED), info);
    expect(phases).toEqual([{ id: 'opensea-0', name: 'Stale Public', kind: 'public', priceWei: '1', startMs: null, endMs: null, maxPerWallet: null, source: 'opensea', mechanism: null, openSeaStageUuid: null }]);
  });

  it('OpenSea listed with zero stages behaves like no OpenSea data at all for the public phase', async () => {
    const phases = await listPhases(46630, CONTRACT, fakeServices(CONFIGURED), dropInfo([]));
    expect(phases).toEqual([{ id: 'public', name: 'Public', kind: 'public', priceWei: (10n ** 16n).toString(), startMs: 1_700_000_000_000, endMs: 1_800_000_000_000, maxPerWallet: 5, source: 'on-chain', mechanism: null, openSeaStageUuid: null }]);
  });
});

describe('listPhases: allow-list mechanism mapping', () => {
  it('"signed_presale" maps to the signed mechanism (confirmed live against a real mainnet drop)', async () => {
    const info = dropInfo([stage({ stageType: 'signed_presale', label: 'FCFS' })]);
    const phases = await listPhases(46630, CONTRACT, fakeServices(NOT_CONFIGURED), info);
    expect(phases[0]!.mechanism).toBe('signed');
  });

  it('a "presale"/"allowlist"-shaped type maps to merkle, this platform\'s existing assumption', async () => {
    for (const stageType of ['presale', 'allowlist_presale', 'allow_list']) {
      const info = dropInfo([stage({ stageType, label: 'X' })]);
      const phases = await listPhases(46630, CONTRACT, fakeServices(NOT_CONFIGURED), info);
      expect(phases[0]!.mechanism, stageType).toBe('merkle');
    }
  });

  it('a type mentioning "token" maps to token-gated, not silently treated as merkle or signed', async () => {
    const info = dropInfo([stage({ stageType: 'token_gated_presale', label: 'Holders' })]);
    const phases = await listPhases(46630, CONTRACT, fakeServices(NOT_CONFIGURED), info);
    expect(phases[0]!.mechanism).toBe('token-gated');
  });

  it('an unrecognised type maps to unknown, never guessed as one of the real mechanisms', async () => {
    const info = dropInfo([stage({ stageType: 'some_future_mechanism', label: 'X' })]);
    const phases = await listPhases(46630, CONTRACT, fakeServices(NOT_CONFIGURED), info);
    expect(phases[0]!.mechanism).toBe('unknown');
  });

  it('the public phase never carries a mechanism, even when on-chain and OpenSea agree it is public_sale', async () => {
    const info = dropInfo([stage({ stageType: 'public_sale', label: 'Public' })]);
    const phases = await listPhases(46630, CONTRACT, fakeServices(CONFIGURED), info);
    expect(phases[0]!.mechanism).toBeNull();
  });
});
