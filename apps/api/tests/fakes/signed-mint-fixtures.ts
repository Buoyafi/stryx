import { encodeFunctionData, getAddress, parseEther, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SEADROP_ABI, signedMintTypedData, type MintParams, type SignedMintValidationParams } from '@stryx/nft-engine';
import type { HeaderFetch } from '../../src/opensea-signed-mint-client.js';

export const CHAIN_ID = 4663;
export const NFT = getAddress('0xc62caba0cf5774d8e40e2651e86a0014de8ab768');
export const FEE_RECIPIENT = getAddress('0x0000a26b00c1f0df003000390027140000faa719');
/** Stands in for OpenSea's signer. A throwaway test key, never a real one. */
export const OPENSEA_SIGNER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
export const STAGE_START_SEC = 1_790_000_000;

export const SIGNED_PARAMS: MintParams = {
  mintPrice: parseEther('0.001'),
  maxTotalMintableByWallet: 2,
  startTime: STAGE_START_SEC,
  endTime: STAGE_START_SEC + 86_400,
  dropStageIndex: 2,
  maxTokenSupplyForStage: 5000n,
  feeBps: 1000,
  restrictFeeRecipients: true,
};

export const SIGNER_BOUNDS: SignedMintValidationParams = {
  minMintPrice: 0n,
  maxMaxTotalMintableByWallet: 10,
  minStartTime: STAGE_START_SEC - 3600,
  maxEndTime: STAGE_START_SEC + 7 * 86_400,
  maxMaxTokenSupplyForStage: 10_000,
  minFeeBps: 0,
  maxFeeBps: 1000,
};

export function signerBoundsMap(bounds: SignedMintValidationParams = SIGNER_BOUNDS) {
  return new Map([[OPENSEA_SIGNER.address.toLowerCase(), bounds]]);
}

/** The calldata OpenSea's mint endpoint would return for `minter`, signed by the fixture signer. */
export async function openSeaCalldataFor(
  minter: `0x${string}`,
  quantity: number,
  overrides: { params?: Partial<MintParams>; feeRecipient?: `0x${string}`; nft?: `0x${string}`; signWith?: typeof OPENSEA_SIGNER; minterIfNotPayer?: `0x${string}` } = {},
): Promise<`0x${string}`> {
  const params = { ...SIGNED_PARAMS, ...overrides.params };
  const feeRecipient = overrides.feeRecipient ?? FEE_RECIPIENT;
  const nftContract = overrides.nft ?? NFT;
  const salt = 42n;
  const signature = await (overrides.signWith ?? OPENSEA_SIGNER).signTypedData(
    signedMintTypedData({ chainId: CHAIN_ID, nftContract, minter, feeRecipient, mintParams: params, salt }),
  );
  return encodeFunctionData({
    abi: SEADROP_ABI,
    functionName: 'mintSigned',
    args: [
      nftContract,
      feeRecipient,
      overrides.minterIfNotPayer ?? zeroAddress,
      BigInt(quantity),
      {
        mintPrice: params.mintPrice,
        maxTotalMintableByWallet: BigInt(params.maxTotalMintableByWallet),
        startTime: BigInt(params.startTime),
        endTime: BigInt(params.endTime),
        dropStageIndex: BigInt(params.dropStageIndex),
        maxTokenSupplyForStage: params.maxTokenSupplyForStage,
        feeBps: BigInt(params.feeBps),
        restrictFeeRecipients: params.restrictFeeRecipients,
      },
      salt,
      signature,
    ],
  });
}

export interface FakeResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A HeaderFetch that answers from `respond`, and records every request. */
export function fakeHeaderFetch(respond: (url: string, init?: { method?: string; body?: string }) => FakeResponse | Promise<FakeResponse>) {
  const requests: Array<{ url: string; method: string; body: unknown; at: number }> = [];
  const fetchImpl: HeaderFetch = async (url, init) => {
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined, at: Date.now() });
    const r = await respond(url, init);
    const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => {
        if (r.body === undefined) throw new Error('no body');
        return r.body;
      },
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    };
  };
  return { fetchImpl, requests };
}

/** A GET /api/v2/drops/{slug} body with one signed FCFS stage. */
export function dropBody(stage: { uuid?: string; start?: string; end?: string | null; type?: string; price?: string } = {}) {
  return {
    collection_name: 'Kid Story',
    stages: [
      {
        uuid: stage.uuid ?? '11111111-2222-3333-4444-555555555555',
        stage_type: stage.type ?? 'signed_presale',
        label: 'FCFS',
        price: stage.price ?? '1000000000000000',
        start_time: stage.start ?? new Date(STAGE_START_SEC * 1000).toISOString(),
        end_time: stage.end === undefined ? new Date((STAGE_START_SEC + 86_400) * 1000).toISOString() : stage.end,
        max_per_wallet: 2,
      },
    ],
  };
}
