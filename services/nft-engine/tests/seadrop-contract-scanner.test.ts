import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { SeaDropContractScanner } from '../src/service/seadrop-contract-scanner.service.js';
import type { SeaDropMintScope } from '../src/types/seadrop.types.js';

const scope: SeaDropMintScope = {
  nftContract: '0x1234567890123456789012345678901234567890',
  chainId: 1,
};

const ZERO_ROOT = ('0x' + '00'.repeat(32)) as `0x${string}`;
const NONZERO_ROOT = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

const ZERO_PUBLIC_DROP = {
  mintPrice: 0n,
  startTime: 0n,
  endTime: 0n,
  maxTotalMintableByWallet: 0n,
  feeBps: 0n,
  restrictFeeRecipients: false,
};

const CONFIGURED_PUBLIC_DROP = {
  mintPrice: parseEther('0.01'),
  startTime: 1_700_000_000n,
  endTime: 1_700_003_600n,
  maxTotalMintableByWallet: 5n,
  feeBps: 500n,
  restrictFeeRecipients: false,
};

function fakeClient(opts: {
  publicDrop: typeof ZERO_PUBLIC_DROP;
  allowListRoot: `0x${string}`;
  supportsInterfaceReverts?: boolean;
  isErc721?: boolean;
}) {
  return {
    async readContract(args: { functionName: string }) {
      switch (args.functionName) {
        case 'getPublicDrop':
          return opts.publicDrop;
        case 'getAllowListMerkleRoot':
          return opts.allowListRoot;
        case 'supportsInterface':
          if (opts.supportsInterfaceReverts) throw new Error('call reverted');
          return opts.isErc721 ?? true;
        default:
          throw new Error(`unexpected functionName in test fake: ${args.functionName}`);
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('SeaDropContractScanner', () => {
  it('reports no SeaDrop configuration for a contract with nothing registered', async () => {
    const client = fakeClient({ publicDrop: ZERO_PUBLIC_DROP, allowListRoot: ZERO_ROOT });
    const scanner = new SeaDropContractScanner(client);

    const result = await scanner.detect(scope);

    expect(result.hasConfiguredPublicDrop).toBe(false);
    expect(result.hasConfiguredAllowList).toBe(false);
    expect(result.hasAnySeaDropConfiguration).toBe(false);
  });

  it('detects a configured public drop', async () => {
    const client = fakeClient({ publicDrop: CONFIGURED_PUBLIC_DROP, allowListRoot: ZERO_ROOT });
    const scanner = new SeaDropContractScanner(client);

    const result = await scanner.detect(scope);

    expect(result.hasConfiguredPublicDrop).toBe(true);
    expect(result.hasConfiguredAllowList).toBe(false);
    expect(result.hasAnySeaDropConfiguration).toBe(true);
  });

  it('detects a configured allow-list stage even with no public drop yet', async () => {
    const client = fakeClient({ publicDrop: ZERO_PUBLIC_DROP, allowListRoot: NONZERO_ROOT });
    const scanner = new SeaDropContractScanner(client);

    const result = await scanner.detect(scope);

    expect(result.hasConfiguredPublicDrop).toBe(false);
    expect(result.hasConfiguredAllowList).toBe(true);
    expect(result.hasAnySeaDropConfiguration).toBe(true);
  });

  it('detects both an active allow-list and a configured public drop simultaneously', async () => {
    const client = fakeClient({ publicDrop: CONFIGURED_PUBLIC_DROP, allowListRoot: NONZERO_ROOT });
    const scanner = new SeaDropContractScanner(client);

    const result = await scanner.detect(scope);

    expect(result.hasConfiguredPublicDrop).toBe(true);
    expect(result.hasConfiguredAllowList).toBe(true);
    expect(result.hasAnySeaDropConfiguration).toBe(true);
  });

  it('treats a reverting supportsInterface call as "unknown", not an error', async () => {
    const client = fakeClient({
      publicDrop: CONFIGURED_PUBLIC_DROP,
      allowListRoot: ZERO_ROOT,
      supportsInterfaceReverts: true,
    });
    const scanner = new SeaDropContractScanner(client);

    const result = await scanner.detect(scope);

    expect(result.supportsErc165).toBe(false);
    expect(result.isErc721).toBe(false);
    // Crucially, the SeaDrop-configuration signal is unaffected by the ERC165 revert:
    expect(result.hasAnySeaDropConfiguration).toBe(true);
  });

  it('reports isErc721 true when supportsInterface succeeds and returns true', async () => {
    const client = fakeClient({ publicDrop: ZERO_PUBLIC_DROP, allowListRoot: ZERO_ROOT, isErc721: true });
    const scanner = new SeaDropContractScanner(client);

    const result = await scanner.detect(scope);

    expect(result.supportsErc165).toBe(true);
    expect(result.isErc721).toBe(true);
  });
});
