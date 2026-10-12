import { describe, expect, it } from 'vitest';
import { getAddress, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { OpenSeaSignedMintClient, activeStageInIneligibleMessage, ineligibleForAnotherStage, parseRetryAfter } from '../src/opensea-signed-mint-client.js';
import { OpenSeaRequestLimiter, PausedPastDeadlineError } from '../src/opensea-request-limiter.js';
import { describeEncodingDifference, validateSignedMintCalldata, type SignedMintContext } from '../src/signed-mint-validator.js';
import { resolveSignedStage } from '../src/signed-mint-start-resolver.js';
import { evaluateClock, readingFromBlock, readingFromHttpDate } from '../src/clock-check.js';
import { gasLimitFor, gasPresetFor, presetFees } from '../src/gas-presets.js';
import {
  CHAIN_ID,
  FEE_RECIPIENT,
  NFT,
  OPENSEA_SIGNER,
  SIGNER_BOUNDS,
  STAGE_START_SEC,
  dropBody,
  fakeHeaderFetch,
  openSeaCalldataFor,
  signerBoundsMap,
} from './fakes/signed-mint-fixtures.js';

const WALLET = getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');

describe('OpenSeaSignedMintClient.requestMintCalldata (POST /api/v2/drops/{slug}/mint)', () => {
  it('sends {minter, quantity} with the API key only, and returns the calldata on success', async () => {
    const calldata = await openSeaCalldataFor(WALLET, 2);
    const { fetchImpl, requests } = fakeHeaderFetch(() => ({ status: 200, body: { transaction: { to: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5', data: calldata } } }));
    const client = new OpenSeaSignedMintClient(fetchImpl, 'key');

    expect(await client.requestMintCalldata('kid-story', WALLET, 2)).toEqual({ kind: 'calldata', calldata, to: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5' });
    expect(requests).toMatchObject([{ url: 'https://api.opensea.io/api/v2/drops/kid-story/mint', method: 'POST', body: { minter: WALLET, quantity: 2 } }]);
  });

  it.each([
    [409, { errors: ['Drop is not currently active for minting'] }, {}, { kind: 'not_active', message: 'Drop is not currently active for minting' }],
    [422, { errors: ['Insufficient balance to mint'] }, {}, { kind: 'insufficient_funds', message: 'Insufficient balance to mint' }],
    [422, { errors: ['Wallet not on allowlist'] }, {}, { kind: 'not_eligible', message: 'Wallet not on allowlist' }],
    [429, undefined, { 'Retry-After': '2' }, { kind: 'rate_limited', retryAfterMs: 2000 }],
    [429, undefined, {}, { kind: 'rate_limited', retryAfterMs: null }],
    [500, { errors: ['boom'] }, {}, { kind: 'error', status: 500, message: 'boom' }],
  ])('classifies HTTP %i', async (status, body, headers, expected) => {
    const { fetchImpl } = fakeHeaderFetch(() => ({ status, body, headers }));
    expect(await new OpenSeaSignedMintClient(fetchImpl, 'key').requestMintCalldata('s', WALLET, 1)).toEqual(expected);
  });

  it('turns a transport failure and a missing API key into an error answer, never a throw', async () => {
    const failing = new OpenSeaSignedMintClient(async () => {
      throw new TypeError('fetch failed');
    }, 'key');
    expect(await failing.requestMintCalldata('s', WALLET, 1)).toEqual({ kind: 'error', status: null, message: 'Could not reach OpenSea.' });
    const { fetchImpl, requests } = fakeHeaderFetch(() => ({ status: 200 }));
    expect((await new OpenSeaSignedMintClient(fetchImpl, undefined).requestMintCalldata('s', WALLET, 1)).kind).toBe('error');
    expect(requests).toHaveLength(0);
  });

  it('parses Retry-After as seconds or as an HTTP date', () => {
    expect(parseRetryAfter('3', 0)).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfter('soon', 0)).toBeNull();
  });
});

describe('reading the active stage out of a 422 "not eligible"', () => {
  const tail = " (signed_presale): the wallet is not on this stage's allowlist. The public stage opens at 2026-09-29T15:00:00Z and any wallet can mint in it then.";
  const stageOf = (m: string) => activeStageInIneligibleMessage(m).activeStage;

  it('picks the name out whatever the punctuation and quoting', () => {
    expect(stageOf(`Wallet is not eligible for the active drop stage 'GTD'${tail}`)).toBe('GTD');
    expect(stageOf(`wallet is not eligible for the active drop stage. 'GTD'${tail}`)).toBe('GTD');
    expect(stageOf(`Wallet is not eligible for the active drop stage: \u2018Early Access\u2019${tail}`)).toBe('Early Access');
    expect(stageOf(`Wallet is not eligible for the active drop stage "GTD"${tail}`)).toBe('GTD');
    expect(stageOf(`Wallet is not eligible for the active drop stage GTD${tail}`)).toBe('GTD');
    expect(stageOf('The active stage GTD is restricted to its allowlist.')).toBe('GTD');
  });

  it('no mention of an active stage: nothing to read', () => {
    expect(activeStageInIneligibleMessage('Wallet is not on the allowlist for this stage')).toEqual({ mentionsActiveStage: false, activeStage: null });
  });

  it('another stage named: other. This stage named (any case): not other. Unnamed: other unless this stage appears', () => {
    expect(ineligibleForAnotherStage(`wallet is not eligible for the active drop stage. 'GTD'${tail}`, 'FCFS')).toEqual({ other: true, activeStage: 'GTD' });
    expect(ineligibleForAnotherStage(`Wallet is not eligible for the active drop stage 'fcfs'${tail}`, 'FCFS')).toEqual({ other: false, activeStage: 'fcfs' });
    expect(ineligibleForAnotherStage('Not eligible for the active drop stage.', 'FCFS')).toEqual({ other: true, activeStage: null });
    expect(ineligibleForAnotherStage('Not eligible for the active drop stage. (FCFS)', 'FCFS')).toEqual({ other: false, activeStage: null });
    expect(ineligibleForAnotherStage('Wallet is not on the allowlist for this stage', 'FCFS')).toEqual({ other: false, activeStage: null });
  });
});

describe('OpenSeaRequestLimiter', () => {
  it('never runs more than maxConcurrent at once', async () => {
    const limiter = new OpenSeaRequestLimiter({ maxConcurrent: 2 });
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        limiter.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it('a 429 pauses everyone: Retry-After when given, else exponential backoff capped, reset by a success', async () => {
    let now = 0;
    const slept: number[] = [];
    const limiter = new OpenSeaRequestLimiter({
      maxConcurrent: 4,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
      random: () => 0.5, // no jitter
    });

    expect(limiter.recordRateLimited(1500)).toBe(1500);
    await limiter.run(async () => undefined);
    expect(slept).toEqual([1500]);

    expect([limiter.recordRateLimited(null), limiter.recordRateLimited(null), limiter.recordRateLimited(null), limiter.recordRateLimited(null), limiter.recordRateLimited(null)]).toEqual([
      500, 1000, 2000, 2000, 2000,
    ]);
    limiter.recordSuccess();
    expect(limiter.recordRateLimited(null)).toBe(250);
  });

  it('a Retry-After of 0 is not "ask again at once": the pause is never shorter than the backoff', () => {
    const limiter = new OpenSeaRequestLimiter({ maxConcurrent: 4, now: () => 0, random: () => 0.5 });
    expect(limiter.recordRateLimited(0)).toBe(250);
    expect(limiter.recordRateLimited(0)).toBe(500);
  });

  it('a pause longer than the caller has left is not slept through: no request is sent after the deadline', async () => {
    let now = 0;
    const slept: number[] = [];
    const limiter = new OpenSeaRequestLimiter({ maxConcurrent: 4, now: () => now, sleep: async (ms) => void ((now += ms), slept.push(ms)), random: () => 0.5 });
    limiter.recordRateLimited(120_000);
    let sent = 0;

    await expect(limiter.run(async () => void sent++, 30_000)).rejects.toBeInstanceOf(PausedPastDeadlineError);
    expect(slept).toEqual([]);
    expect(sent).toBe(0);

    // The slot was given back, and a caller with time to spare still waits the pause out.
    await limiter.run(async () => void sent++, 500_000);
    expect(sent).toBe(1);
    expect(slept).toEqual([120_000]);
  });
});

describe('validateSignedMintCalldata', () => {
  const ctx = (over: Partial<SignedMintContext> = {}): SignedMintContext => ({
    chainId: CHAIN_ID,
    nftContract: NFT,
    walletAddress: WALLET,
    quantity: 2,
    maxPriceWei: parseEther('0.001'),
    signerBounds: signerBoundsMap(),
    allowedFeeRecipients: new Set([FEE_RECIPIENT.toLowerCase()]),
    ...over,
  });

  it('accepts a correct payload: our own rebuilt tx, value = price x quantity, the recovered signer', async () => {
    const calldata = await openSeaCalldataFor(WALLET, 2);
    const result = await validateSignedMintCalldata(calldata, ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tx.data).toBe(calldata);
    expect(result.tx.value).toBe(parseEther('0.002'));
    expect(result.signer).toBe(OPENSEA_SIGNER.address);
  });

  it('accepts OpenSea calldata with extra trailing bytes (an attribution tag): signs OUR encoding and notes the difference', async () => {
    const calldata = await openSeaCalldataFor(WALLET, 2);
    const tagged = `${calldata}1d4da48b00000000` as `0x${string}`;
    const result = await validateSignedMintCalldata(tagged, ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tx.data).toBe(calldata); // the tag is not in what gets signed
    expect(result.note).toMatch(/8 extra trailing bytes \(0x1d4da48b00000000\)/);
  });

  it('a clean response carries no note', async () => {
    const result = await validateSignedMintCalldata(await openSeaCalldataFor(WALLET, 2), ctx());
    expect(result.ok && result.note).toBeNull();
  });

  it('describeEncodingDifference: names where a non-canonical encoding first differs', () => {
    expect(describeEncodingDifference('0xaabbcc', '0xaabbdd')).toMatch(/first difference at byte 2/);
    expect(describeEncodingDifference('0xaa', '0xaa')).toBeNull();
  });

  it('accepts minterIfNotPayer set to the wallet itself (equivalent on-chain), rebuilding with zero', async () => {
    const calldata = await openSeaCalldataFor(WALLET, 2, { minterIfNotPayer: WALLET });
    const result = await validateSignedMintCalldata(calldata, ctx());
    expect(result.ok).toBe(true);
  });

  const refusals: Array<[string, () => Promise<`0x${string}`>, Partial<SignedMintContext>]> = [
    ['calldata_invalid', async () => '0xdeadbeef', {}],
    ['wrong_contract', () => openSeaCalldataFor(WALLET, 2, { nft: getAddress('0x1234567890123456789012345678901234567890') }), {}],
    ['wrong_minter', () => openSeaCalldataFor(WALLET, 2, { minterIfNotPayer: getAddress('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc') }), {}],
    ['wrong_quantity', () => openSeaCalldataFor(WALLET, 1), {}],
    ['unknown_signer', () => openSeaCalldataFor(WALLET, 2, { signWith: privateKeyToAccount('0x' + '11'.repeat(32) as `0x${string}`) }), {}],
    ['outside_signer_bounds', () => openSeaCalldataFor(WALLET, 2, { params: { startTime: STAGE_START_SEC - 7200 } }), {}],
    ['outside_signer_bounds', () => openSeaCalldataFor(WALLET, 2, { params: { restrictFeeRecipients: false } }), {}],
    ['fee_recipient_not_allowed', () => openSeaCalldataFor(WALLET, 2, { feeRecipient: getAddress('0x000000000000000000000000000000000000beef') }), {}],
    ['price_above_expected', () => openSeaCalldataFor(WALLET, 2, { params: { mintPrice: parseEther('0.002') } }), {}],
  ];
  it.each(refusals)('refuses: %s', async (reason, make, over) => {
    const result = await validateSignedMintCalldata(await make(), ctx(over));
    expect(result).toMatchObject({ ok: false, reason });
  });

  it('refuses a signature issued for a different wallet (it recovers to a stranger)', async () => {
    const forSomeoneElse = await openSeaCalldataFor(getAddress('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'), 2);
    expect(await validateSignedMintCalldata(forSomeoneElse, ctx())).toMatchObject({ ok: false, reason: 'unknown_signer' });
  });
});

describe('resolveSignedStage', () => {
  const reader = (bounds = SIGNER_BOUNDS, signers: `0x${string}`[] = [OPENSEA_SIGNER.address]) =>
    ({
      getSigners: async () => signers,
      getSignedMintValidationParams: async () => bounds,
    }) as never;
  const params = { slug: 'kid-story', stageUuid: '11111111222233334444555555555555', chainId: CHAIN_ID, contract: NFT };

  it("uses OpenSea's start time (uuid matched regardless of hyphens) once it sits inside the on-chain bounds", async () => {
    const { fetchImpl } = fakeHeaderFetch(() => ({ status: 200, body: dropBody(), headers: { Date: new Date().toUTCString() } }));
    const result = await resolveSignedStage(new OpenSeaSignedMintClient(fetchImpl, 'key'), reader(), params);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.timing.startMs).toBe(STAGE_START_SEC * 1000);
    expect(result.timing.priceWei).toBe('1000000000000000');
    expect(result.timing.onChainWindow.signerCount).toBe(1);
    expect(result.snapshot.serverDateMs).not.toBeNull();
  });

  it.each([
    ['stage_not_found', dropBody({ uuid: 'aaaa' }), SIGNER_BOUNDS, [OPENSEA_SIGNER.address]],
    ['not_signed_stage', dropBody({ type: 'public_sale' }), SIGNER_BOUNDS, [OPENSEA_SIGNER.address]],
    ['no_start_time', dropBody({ start: 'not a date' }), SIGNER_BOUNDS, [OPENSEA_SIGNER.address]],
    ['no_signers', dropBody(), SIGNER_BOUNDS, []],
    ['outside_onchain_bounds', dropBody(), { ...SIGNER_BOUNDS, minStartTime: STAGE_START_SEC + 60 }, [OPENSEA_SIGNER.address]],
  ] as const)('refuses: %s', async (reason, body, bounds, signers) => {
    const { fetchImpl } = fakeHeaderFetch(() => ({ status: 200, body }));
    const result = await resolveSignedStage(new OpenSeaSignedMintClient(fetchImpl, 'key'), reader(bounds, [...signers]), params);
    expect(result).toMatchObject({ ok: false, reason });
  });

  it('reports OpenSea being unreachable as its own reason', async () => {
    const { fetchImpl } = fakeHeaderFetch(() => ({ status: 503 }));
    expect(await resolveSignedStage(new OpenSeaSignedMintClient(fetchImpl, 'key'), reader(), params)).toMatchObject({ ok: false, reason: 'opensea_unavailable' });
  });
});

describe('clock check', () => {
  it('centres each 1-second reference and flags a skew beyond 1s', () => {
    const now = 1_790_000_000_000;
    const inSync = evaluateClock([readingFromHttpDate(now - 400, now, 100), readingFromBlock(Math.floor(now / 1000), now, 100)]);
    expect(inSync.skewed).toBe(false);

    // A quiet Orbit chain's latest block can be seconds old: being ahead of it is not skew.
    const oldBlock = evaluateClock([readingFromHttpDate(now - 400, now, 100), readingFromBlock(Math.floor(now / 1000) - 12, now, 100)]);
    expect(oldBlock.skewed).toBe(false);
    expect(oldBlock.summary).toMatch(/latest block may simply be old/);
    // Being BEHIND the latest block is real evidence.
    expect(evaluateClock([readingFromBlock(Math.floor(now / 1000) + 3, now, 100)]).skewed).toBe(true);

    const ahead = evaluateClock([readingFromHttpDate(now - 2_000, now, 100)]);
    expect(ahead.skewed).toBe(true);
    expect(ahead.readings[0]!.offsetMs).toBe(1_500);
    expect(ahead.summary).toMatch(/opensea \+1500ms/);
  });
});

describe('gas presets', () => {
  it('scales the limit per token and pads the warm-up fee estimate, with a floor', () => {
    const preset = gasPresetFor(CHAIN_ID);
    expect(gasLimitFor(preset, 1)).toBe(400_000n);
    expect(gasLimitFor(preset, 3)).toBe(480_000n);
    expect(presetFees(preset, { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 0n })).toEqual({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 0n });
    expect(presetFees(preset, { maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 0n }).maxFeePerGas).toBe(100_000_000n);
  });
});
