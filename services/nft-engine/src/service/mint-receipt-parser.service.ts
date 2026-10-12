import { parseEventLogs, type TransactionReceipt } from 'viem';
import { ERC721_ABI } from '../utils/erc721-abi.js';
import { ERC1155_ABI } from '../utils/erc1155-abi.js';

export interface MintedToken {
  /** Decimal string: a tokenId routinely exceeds JS's safe-integer range. */
  tokenId: string;
  /** "1" for a 721; a 1155's real minted quantity for that tokenId otherwise. */
  amount: string;
}

/**
 * Reads which tokenIds a confirmed mint produced, from the Transfer (721) or
 * TransferSingle/TransferBatch (1155) logs minted to `toAddress`.
 */
export function parseMintedTokens(
  receipt: TransactionReceipt,
  standard: 'erc721' | 'erc1155',
  toAddress: `0x${string}`,
  contract: `0x${string}`,
): MintedToken[] {
  const to = toAddress.toLowerCase();
  const from = contract.toLowerCase();
  const logs = receipt.logs.filter((log) => log.address.toLowerCase() === from);

  if (standard === 'erc721') {
    return parseEventLogs({ abi: ERC721_ABI, eventName: 'Transfer', logs, strict: false })
      .filter((log) => log.args.to !== undefined && log.args.tokenId !== undefined && log.args.to.toLowerCase() === to)
      .map((log) => ({ tokenId: log.args.tokenId!.toString(), amount: '1' }));
  }

  const singles = parseEventLogs({ abi: ERC1155_ABI, eventName: 'TransferSingle', logs, strict: false })
    .filter((log) => log.args.to !== undefined && log.args.id !== undefined && log.args.value !== undefined && log.args.to.toLowerCase() === to)
    .map((log) => ({ tokenId: log.args.id!.toString(), amount: log.args.value!.toString() }));

  const batches = parseEventLogs({ abi: ERC1155_ABI, eventName: 'TransferBatch', logs, strict: false })
    .filter((log) => log.args.to !== undefined && log.args.ids !== undefined && log.args.values !== undefined && log.args.to.toLowerCase() === to)
    .flatMap((log) => log.args.ids!.map((id, i) => ({ tokenId: id.toString(), amount: log.args.values![i]!.toString() })));

  return [...singles, ...batches];
}
