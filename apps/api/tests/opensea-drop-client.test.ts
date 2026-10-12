import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseEther } from 'viem';
import { SEADROP_ABI } from '@stryx/nft-engine';
import { decodeAllowListCalldata, OpenSeaDropClient, OpenSeaDropError } from '../src/opensea-drop-client.js';
import type { FetchLike } from '../src/opensea-resolver.js';

const NFT = '0x1234567890123456789012345678901234567890';
const FEE = '0x0000a26b00c1F0DF003000390027140000fAa719';
const MINTER = '0x000000000000000000000000000000000000dEaD';

function buildMintAllowListCalldata(proof: `0x${string}`[]) {
  return encodeFunctionData({
    abi: SEADROP_ABI,
    functionName: 'mintAllowList',
    args: [
      NFT,
      FEE,
      MINTER,
      2n,
      {
        mintPrice: parseEther('0.01'),
        maxTotalMintableByWallet: 5n,
        startTime: 1700000000n,
        endTime: 2000000000n,
        dropStageIndex: 1n,
        maxTokenSupplyForStage: 1000n,
        feeBps: 250n,
        restrictFeeRecipients: false,
      },
      proof,
    ],
  });
}

describe('decodeAllowListCalldata', () => {
  it('extracts mintParams and proof from real mintAllowList calldata', () => {
    const proof = [('0x' + 'ab'.repeat(32)) as `0x${string}`, ('0x' + 'cd'.repeat(32)) as `0x${string}`];
    const calldata = buildMintAllowListCalldata(proof);

    const result = decodeAllowListCalldata(calldata);

    expect(result.proof).toEqual(proof);
    expect(result.mintParams.mintPrice).toBe(parseEther('0.01'));
    expect(result.mintParams.dropStageIndex).toBe(1);
    expect(result.mintParams.maxTotalMintableByWallet).toBe(5);
    expect(result.mintParams.restrictFeeRecipients).toBe(false);
  });

  it('rejects calldata for a different SeaDrop function (mintPublic has no proof)', () => {
    const publicCalldata = encodeFunctionData({
      abi: SEADROP_ABI,
      functionName: 'mintPublic',
      args: [NFT, FEE, MINTER, 1n],
    });

    expect(() => decodeAllowListCalldata(publicCalldata)).toThrow(OpenSeaDropError);
    expect(() => decodeAllowListCalldata(publicCalldata)).toThrow(/mintAllowList/);
  });

  it('rejects garbage calldata that does not decode as SeaDrop at all', () => {
    expect(() => decodeAllowListCalldata('0xdeadbeef')).toThrow(OpenSeaDropError);
  });
});

function fakeFetch(status: number, body: unknown): FetchLike {
  return (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as FetchLike;
}

describe('OpenSeaDropClient.fetchAllowListData: mapping OpenSea\'s HTTP responses to typed errors', () => {
  const MINTER = '0x0000a26b00c1F0DF003000390027140000fAa719' as `0x${string}`;

  it('a 422 whose message says "insufficient balance" (verified live, this is OpenSea\'s real text for an unfunded wallet) maps to insufficient_funds, NOT not_eligible', async () => {
    const client = new OpenSeaDropClient(fakeFetch(422, { errors: ['Insufficient balance to mint'] }), 'key');

    const err = await client.fetchAllowListData('facetsart', MINTER, 1).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OpenSeaDropError);
    expect((err as OpenSeaDropError).code).toBe('insufficient_funds');
    expect((err as OpenSeaDropError).message).toBe('Insufficient balance to mint');
  });

  it('any OTHER 422 message still maps to not_eligible (the previous, still-correct behavior for an actual allow-list rejection), carrying OpenSea\'s real text', async () => {
    const client = new OpenSeaDropClient(fakeFetch(422, { errors: ['Wallet exceeds allowed mint quantity'] }), 'key');

    const err = await client.fetchAllowListData('facetsart', MINTER, 1).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OpenSeaDropError);
    expect((err as OpenSeaDropError).code).toBe('not_eligible');
    expect((err as OpenSeaDropError).message).toBe('Wallet exceeds allowed mint quantity');
  });

  it('a 422 with no parseable body still falls back to a generic not_eligible message rather than throwing a second error', async () => {
    const client = new OpenSeaDropClient(
      (async () => ({ ok: false, status: 422, json: async () => { throw new Error('not json'); } })) as unknown as FetchLike,
      'key',
    );

    const err = await client.fetchAllowListData('facetsart', MINTER, 1).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OpenSeaDropError);
    expect((err as OpenSeaDropError).code).toBe('not_eligible');
  });

  it('404 and 409 also carry OpenSea\'s real message when one is present', async () => {
    const notFound = new OpenSeaDropClient(fakeFetch(404, { errors: ['No such drop'] }), 'key');
    const notActive = new OpenSeaDropClient(fakeFetch(409, { errors: ['Drop has ended'] }), 'key');

    const notFoundErr = await notFound.fetchAllowListData('nope', MINTER, 1).catch((e: unknown) => e);
    const notActiveErr = await notActive.fetchAllowListData('facetsart', MINTER, 1).catch((e: unknown) => e);

    expect((notFoundErr as OpenSeaDropError).code).toBe('not_found');
    expect((notFoundErr as OpenSeaDropError).message).toBe('No such drop');
    expect((notActiveErr as OpenSeaDropError).code).toBe('not_active');
    expect((notActiveErr as OpenSeaDropError).message).toBe('Drop has ended');
  });

  it('a successful response still decodes normally (the error-message plumbing does not disturb the happy path)', async () => {
    const calldata = buildMintAllowListCalldata([('0x' + 'ab'.repeat(32)) as `0x${string}`]);
    const client = new OpenSeaDropClient(fakeFetch(200, { transaction: { data: calldata } }), 'key');

    const result = await client.fetchAllowListData('facetsart', MINTER, 2);

    expect(result.mintParams.maxTotalMintableByWallet).toBe(5);
    expect(result.proof).toHaveLength(1);
  });

  it('requires an API key before making any request', async () => {
    const client = new OpenSeaDropClient(
      (() => {
        throw new Error('fetch should not be called without an API key');
      }) as unknown as FetchLike,
      undefined,
    );

    await expect(client.fetchAllowListData('facetsart', MINTER, 1)).rejects.toMatchObject({ code: 'no_api_key' });
  });
});

describe('OpenSeaDropClient.fetchAllowListData: a raw network-transport failure (Node fetch throwing, not an HTTP error response)', () => {
  it('retries once and succeeds, rather than failing on the first transient failure', async () => {
    let calls = 0;
    const calldata = buildMintAllowListCalldata([('0x' + 'ab'.repeat(32)) as `0x${string}`]);
    const fetchImpl: FetchLike = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return { ok: true, status: 200, json: async () => ({ transaction: { data: calldata } }) };
    }) as unknown as FetchLike;
    const client = new OpenSeaDropClient(fetchImpl, 'key');

    const result = await client.fetchAllowListData('facetsart', MINTER, 1);
    expect(result.proof).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('throws a typed OpenSeaDropError (network_unavailable), not a raw TypeError, once retries are exhausted: resolveAllowListProof only recognizes OpenSeaDropError, so this used to reach the caller as a bare 500', async () => {
    const fetchImpl: FetchLike = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as FetchLike;
    const client = new OpenSeaDropClient(fetchImpl, 'key');

    await expect(client.fetchAllowListData('facetsart', MINTER, 1)).rejects.toMatchObject({ code: 'network_unavailable' });
  });

  it('does not retry a real HTTP error response, only a raw transport failure', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls += 1;
      return { ok: false, status: 500, json: async () => ({ errors: ['server error'] }) };
    }) as unknown as FetchLike;
    const client = new OpenSeaDropClient(fetchImpl, 'key');

    await expect(client.fetchAllowListData('facetsart', MINTER, 1)).rejects.toMatchObject({ code: 'bad_response' });
    expect(calls).toBe(1);
  });
});
