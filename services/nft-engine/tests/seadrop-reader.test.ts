import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { isRpcTransportFailure } from '@stryx/utils';
import { SeaDropReader } from '../src/service/seadrop-reader.service.js';
import type { SeaDropMintScope } from '../src/types/seadrop.types.js';

const scope: SeaDropMintScope = {
  nftContract: '0x1234567890123456789012345678901234567890',
  chainId: 1,
};

/** Minimal fake satisfying only the readContract calls SeaDropReader makes. */
function fakeClient(overrides: {
  publicDrop?: {
    mintPrice: bigint;
    startTime: bigint;
    endTime: bigint;
    maxTotalMintableByWallet: bigint;
    feeBps: bigint;
    restrictFeeRecipients: boolean;
  };
  merkleRoot?: `0x${string}`;
  feeRecipients?: readonly `0x${string}`[];
  mintStats?: readonly [bigint, bigint, bigint];
  signers?: readonly `0x${string}`[];
  signedParams?: Record<string, unknown>;
  onReadContract?: (args: { address: string; functionName: string }) => void;
}) {
  return {
    async readContract(args: { address: string; functionName: string }) {
      overrides.onReadContract?.(args);
      switch (args.functionName) {
        case 'getPublicDrop':
          return overrides.publicDrop;
        case 'getAllowListMerkleRoot':
          return overrides.merkleRoot;
        case 'getAllowedFeeRecipients':
          return overrides.feeRecipients;
        case 'getMintStats':
          return overrides.mintStats;
        case 'getSigners':
          return overrides.signers;
        case 'getSignedMintValidationParams':
          return overrides.signedParams;
        default:
          throw new Error(`unexpected functionName in test fake: ${args.functionName}`);
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('SeaDropReader', () => {
  it('parses getPublicDrop into a typed PublicDrop object', async () => {
    const client = fakeClient({
      publicDrop: {
        mintPrice: parseEther('0.01'),
        startTime: 1_700_000_000n,
        endTime: 1_700_003_600n,
        maxTotalMintableByWallet: 5n,
        feeBps: 500n,
        restrictFeeRecipients: true,
      },
    });
    const reader = new SeaDropReader(client);

    const drop = await reader.getPublicDrop(scope);

    expect(drop.mintPrice).toBe(parseEther('0.01'));
    expect(drop.startTime).toBe(1_700_000_000);
    expect(drop.maxTotalMintableByWallet).toBe(5);
    expect(drop.restrictFeeRecipients).toBe(true);
  });

  it('treats startTime === 0 as an inactive public stage', async () => {
    const client = fakeClient({
      publicDrop: {
        mintPrice: 0n,
        startTime: 0n,
        endTime: 0n,
        maxTotalMintableByWallet: 0n,
        feeBps: 0n,
        restrictFeeRecipients: false,
      },
    });
    const reader = new SeaDropReader(client);

    const active = await reader.isPublicStageActive(scope, 1_700_000_500);
    expect(active).toBe(false);
  });

  it('reports the public stage active when now falls within [startTime, endTime]', async () => {
    const client = fakeClient({
      publicDrop: {
        mintPrice: parseEther('0.01'),
        startTime: 1_700_000_000n,
        endTime: 1_700_003_600n,
        maxTotalMintableByWallet: 5n,
        feeBps: 500n,
        restrictFeeRecipients: false,
      },
    });
    const reader = new SeaDropReader(client);

    expect(await reader.isPublicStageActive(scope, 1_700_000_500)).toBe(true);
    expect(await reader.isPublicStageActive(scope, 1_699_999_999)).toBe(false);
    expect(await reader.isPublicStageActive(scope, 1_700_003_601)).toBe(false);
  });

  it('reads the allow-list Merkle root', async () => {
    const root = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
    const client = fakeClient({ merkleRoot: root });
    const reader = new SeaDropReader(client);

    expect(await reader.getAllowListMerkleRoot(scope)).toBe(root);
  });

  it('reads allowed fee recipients', async () => {
    const recipients = ['0x0000a26b00c1F0DF003000390027140000fAa719'] as const;
    const client = fakeClient({ feeRecipients: recipients });
    const reader = new SeaDropReader(client);

    expect(await reader.getAllowedFeeRecipients(scope)).toEqual(recipients);
  });

  it('reads getMintStats against the TOKEN contract, not SEADROP_ADDRESS, and narrows the tuple correctly', async () => {
    let calledAddress: string | undefined;
    const client = fakeClient({
      mintStats: [10n, 50n, 100n],
      onReadContract: (args) => {
        calledAddress = args.address;
      },
    });
    const reader = new SeaDropReader(client);
    const minter = '0x0000a26b00c1F0DF003000390027140000fAa719' as `0x${string}`;

    const stats = await reader.getMintStats(scope, minter);

    expect(stats).toEqual({ minterNumMinted: 10, currentTotalSupply: 50n, maxSupply: 100n });
    // Guards against reading a per-wallet mint count from the shared SeaDrop contract instead of the
    // token.
    expect(calledAddress).toBe(scope.nftContract);
  });

  it('does not hang forever on an unresponsive RPC, each read has an explicit timeout, classifiable as an RPC transport failure', async () => {
    const neverRespondingClient = {
      async readContract() {
        return new Promise(() => undefined); // never settles
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const reader = new SeaDropReader(neverRespondingClient);

    const err = await reader.getPublicDrop(scope).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isRpcTransportFailure(err)).toBe(true);
  }, 10_000);

  it('reads the signed-mint signers and one signer\'s validation bounds into typed values', async () => {
    const signer = '0x00000000000000000000000000000000000000aa' as const;
    const seen: string[] = [];
    const client = fakeClient({
      signers: [signer],
      signedParams: {
        minMintPrice: 0n,
        maxMaxTotalMintableByWallet: 2,
        minStartTime: 1_790_000_000,
        maxEndTime: 1_800_000_000,
        maxMaxTokenSupplyForStage: 5000,
        minFeeBps: 0,
        maxFeeBps: 1000,
      },
      onReadContract: (args) => seen.push(args.functionName),
    });
    const reader = new SeaDropReader(client);

    expect(await reader.getSigners(scope)).toEqual([signer]);
    expect(await reader.getSignedMintValidationParams(scope, signer)).toEqual({
      minMintPrice: 0n,
      maxMaxTotalMintableByWallet: 2,
      minStartTime: 1_790_000_000,
      maxEndTime: 1_800_000_000,
      maxMaxTokenSupplyForStage: 5000,
      minFeeBps: 0,
      maxFeeBps: 1000,
    });
    expect(seen).toEqual(['getSigners', 'getSignedMintValidationParams']);
  });
});
