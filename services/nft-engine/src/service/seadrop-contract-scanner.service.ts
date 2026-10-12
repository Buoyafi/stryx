import type { PublicClient } from 'viem';
import { ERC165_ABI, ERC721_INTERFACE_ID } from '../utils/erc165-abi.js';
import { SeaDropReader } from './seadrop-reader.service.js';
import type { SeaDropMintScope } from '../types/seadrop.types.js';
import type { SeaDropDetectionResult } from '../types/detection.types.js';

const ZERO_BYTES32 = ('0x' + '00'.repeat(32)) as `0x${string}`;

/**
 * Detects whether a contract has a drop registered with SeaDrop. It does not check the SeaDrop token
 * ERC165 interface ID: see erc165-abi.ts.
 */
export class SeaDropContractScanner {
  private readonly seaDropReader: SeaDropReader;

  constructor(private readonly client: PublicClient) {
    this.seaDropReader = new SeaDropReader(client);
  }

  async detect(scope: SeaDropMintScope): Promise<SeaDropDetectionResult> {
    const [erc721Check, publicDrop, allowListRoot] = await Promise.all([
      this.checkErc721Support(scope.nftContract as `0x${string}`),
      this.seaDropReader.getPublicDrop(scope),
      this.seaDropReader.getAllowListMerkleRoot(scope),
    ]);

    const hasConfiguredPublicDrop = publicDrop.startTime !== 0;
    const hasConfiguredAllowList = allowListRoot !== ZERO_BYTES32;

    return {
      isErc721: erc721Check.isErc721,
      supportsErc165: erc721Check.supportsErc165,
      hasConfiguredPublicDrop,
      hasConfiguredAllowList,
      hasAnySeaDropConfiguration: hasConfiguredPublicDrop || hasConfiguredAllowList,
    };
  }

  /** ERC165 checks are advisory: a revert is normal for contracts that do not implement supportsInterface. */
  private async checkErc721Support(
    address: `0x${string}`,
  ): Promise<{ isErc721: boolean; supportsErc165: boolean }> {
    try {
      const isErc721 = await this.client.readContract({
        address,
        abi: ERC165_ABI,
        functionName: 'supportsInterface',
        args: [ERC721_INTERFACE_ID],
      });
      return { isErc721, supportsErc165: true };
    } catch {
      return { isErc721: false, supportsErc165: false };
    }
  }
}
