import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, zeroAddress, type Log, type TransactionReceipt } from 'viem';
import { parseMintedTokens } from '../src/service/mint-receipt-parser.service.js';
import { ERC721_ABI } from '../src/utils/erc721-abi.js';
import { ERC1155_ABI } from '../src/utils/erc1155-abi.js';

const CONTRACT = getAddress('0x1234567890123456789012345678901234567890');
const MINTER = getAddress('0x1111111111111111111111111111111111111111');
const OTHER_WALLET = getAddress('0x9999999999999999999999999999999999999999');
const ZERO = zeroAddress;

function baseLog(topics: readonly (`0x${string}` | `0x${string}`[] | null)[], data: `0x${string}`): Log {
  return {
    address: CONTRACT,
    topics: topics as [`0x${string}`, ...`0x${string}`[]],
    data,
    blockHash: '0xblock',
    blockNumber: 1n,
    logIndex: 0,
    removed: false,
    transactionHash: '0xtx',
    transactionIndex: 0,
  } as unknown as Log;
}

function receiptWith(...logs: Log[]): TransactionReceipt {
  return { logs } as unknown as TransactionReceipt;
}

describe('parseMintedTokens: erc721', () => {
  it('reads the tokenId minted to the given wallet from a real Transfer log', () => {
    const topics = encodeEventTopics({ abi: ERC721_ABI, eventName: 'Transfer', args: { from: ZERO, to: MINTER, tokenId: 42n } });
    const receipt = receiptWith(baseLog(topics, '0x'));

    expect(parseMintedTokens(receipt, 'erc721', MINTER, CONTRACT)).toEqual([{ tokenId: '42', amount: '1' }]);
  });

  it('ignores a Transfer log minted to a different wallet', () => {
    const topics = encodeEventTopics({ abi: ERC721_ABI, eventName: 'Transfer', args: { from: ZERO, to: OTHER_WALLET, tokenId: 1n } });
    const receipt = receiptWith(baseLog(topics, '0x'));

    expect(parseMintedTokens(receipt, 'erc721', MINTER, CONTRACT)).toEqual([]);
  });

  it('collects every tokenId when a batch mint produces more than one Transfer log', () => {
    const t1 = encodeEventTopics({ abi: ERC721_ABI, eventName: 'Transfer', args: { from: ZERO, to: MINTER, tokenId: 10n } });
    const t2 = encodeEventTopics({ abi: ERC721_ABI, eventName: 'Transfer', args: { from: ZERO, to: MINTER, tokenId: 11n } });
    const receipt = receiptWith(baseLog(t1, '0x'), baseLog(t2, '0x'));

    expect(parseMintedTokens(receipt, 'erc721', MINTER, CONTRACT)).toEqual([
      { tokenId: '10', amount: '1' },
      { tokenId: '11', amount: '1' },
    ]);
  });

  it('never throws on an unrelated log in the same receipt (a different event entirely)', () => {
    const unrelated = baseLog(['0xdeadbeef00000000000000000000000000000000000000000000000000000000'], '0x1234');
    const receipt = receiptWith(unrelated);
    expect(parseMintedTokens(receipt, 'erc721', MINTER, CONTRACT)).toEqual([]);
  });
});

describe('parseMintedTokens: erc1155', () => {
  it('reads tokenId and amount from a TransferSingle log', () => {
    const topics = encodeEventTopics({ abi: ERC1155_ABI, eventName: 'TransferSingle', args: { operator: MINTER, from: ZERO, to: MINTER } });
    const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [7n, 3n]);
    const receipt = receiptWith(baseLog(topics, data));

    expect(parseMintedTokens(receipt, 'erc1155', MINTER, CONTRACT)).toEqual([{ tokenId: '7', amount: '3' }]);
  });

  it('reads every tokenId/amount pair from a TransferBatch log', () => {
    const topics = encodeEventTopics({ abi: ERC1155_ABI, eventName: 'TransferBatch', args: { operator: MINTER, from: ZERO, to: MINTER } });
    const data = encodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], [[5n, 6n], [2n, 9n]]);
    const receipt = receiptWith(baseLog(topics, data));

    expect(parseMintedTokens(receipt, 'erc1155', MINTER, CONTRACT)).toEqual([
      { tokenId: '5', amount: '2' },
      { tokenId: '6', amount: '9' },
    ]);
  });

  it('ignores a TransferSingle log minted to a different wallet', () => {
    const topics = encodeEventTopics({ abi: ERC1155_ABI, eventName: 'TransferSingle', args: { operator: MINTER, from: ZERO, to: OTHER_WALLET } });
    const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [1n, 1n]);
    const receipt = receiptWith(baseLog(topics, data));

    expect(parseMintedTokens(receipt, 'erc1155', MINTER, CONTRACT)).toEqual([]);
  });
});

describe('parseMintedTokens: only the collection being minted', () => {
  const OTHER_CONTRACT = getAddress('0x7777777777777777777777777777777777777777');
  const from = (address: `0x${string}`, log: Log): Log => ({ ...log, address });

  it('ignores an NFT another collection sent to the wallet in the same transaction', () => {
    const mine = encodeEventTopics({ abi: ERC721_ABI, eventName: 'Transfer', args: { from: ZERO, to: MINTER, tokenId: 42n } });
    const bonus = encodeEventTopics({ abi: ERC721_ABI, eventName: 'Transfer', args: { from: ZERO, to: MINTER, tokenId: 9001n } });
    const receipt = receiptWith(baseLog(mine, '0x'), from(OTHER_CONTRACT, baseLog(bonus, '0x')));

    expect(parseMintedTokens(receipt, 'erc721', MINTER, CONTRACT)).toEqual([{ tokenId: '42', amount: '1' }]);
  });

  it('ignores another collection for a 1155 as well', () => {
    const topics = encodeEventTopics({ abi: ERC1155_ABI, eventName: 'TransferSingle', args: { operator: MINTER, from: ZERO, to: MINTER } });
    const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [7n, 3n]);
    const receipt = receiptWith(from(OTHER_CONTRACT, baseLog(topics, data)));

    expect(parseMintedTokens(receipt, 'erc1155', MINTER, CONTRACT)).toEqual([]);
  });

  it('matches the collection whatever the letter case of its address', () => {
    const topics = encodeEventTopics({ abi: ERC721_ABI, eventName: 'Transfer', args: { from: ZERO, to: MINTER, tokenId: 42n } });
    const receipt = receiptWith(baseLog(topics, '0x'));

    expect(parseMintedTokens(receipt, 'erc721', MINTER, CONTRACT.toLowerCase() as `0x${string}`)).toEqual([{ tokenId: '42', amount: '1' }]);
  });
});
