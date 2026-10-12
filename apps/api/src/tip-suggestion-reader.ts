import { toHex, type PublicClient } from 'viem';
import type { BlockStamp, MintTxRef, TipChainReader } from './tip-suggestion.service.js';

/** keccak256("Transfer(address,address,uint256)"). */
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** keccak256("TransferSingle(address,address,address,uint256,uint256)") and TransferBatch: ERC-1155. */
const TRANSFER_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const TRANSFER_BATCH = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';
const ZERO_TOPIC = `0x${'0'.repeat(64)}`;

interface RawLog {
  transactionHash: `0x${string}` | null;
  blockNumber: `0x${string}` | null;
  transactionIndex: `0x${string}` | null;
}

/** The chain reads TipSuggestionService needs, over one chain's viem client. */
export class ViemTipChainReader implements TipChainReader {
  constructor(private readonly client: PublicClient) {}

  async feeHistory(blockCount: number, percentiles: number[]) {
    const h = await this.client.getFeeHistory({ blockCount, rewardPercentiles: percentiles, blockTag: 'latest' });
    return { reward: h.reward ?? [], gasUsedRatio: h.gasUsedRatio, baseFeePerGas: h.baseFeePerGas };
  }

  async latestBlock(): Promise<BlockStamp> {
    return stamp(await this.client.getBlock({ blockTag: 'latest' }));
  }

  async block(number: bigint): Promise<BlockStamp> {
    return stamp(await this.client.getBlock({ blockNumber: number }));
  }

  /** A mint is a transfer from the zero address, whatever function or contract the minter called. */
  async mintTxs(contract: `0x${string}`, fromBlock: bigint, toBlock: bigint): Promise<MintTxRef[]> {
    const range = { address: contract, fromBlock: toHex(fromBlock), toBlock: toHex(toBlock) };
    const getLogs = (topics: (string | string[] | null)[]) =>
      this.client.request({ method: 'eth_getLogs', params: [{ ...range, topics }] } as never) as Promise<RawLog[]>;
    const [erc721, erc1155] = await Promise.all([getLogs([TRANSFER, ZERO_TOPIC]), getLogs([[TRANSFER_SINGLE, TRANSFER_BATCH], null, ZERO_TOPIC])]);

    const seen = new Map<string, { ref: MintTxRef; index: bigint }>();
    for (const log of [...erc721, ...erc1155]) {
      if (!log.transactionHash || !log.blockNumber || seen.has(log.transactionHash)) continue;
      seen.set(log.transactionHash, { ref: { hash: log.transactionHash, blockNumber: BigInt(log.blockNumber) }, index: BigInt(log.transactionIndex ?? '0x0') });
    }
    return [...seen.values()]
      .sort((a, b) => (a.ref.blockNumber !== b.ref.blockNumber ? (a.ref.blockNumber < b.ref.blockNumber ? -1 : 1) : a.index < b.index ? -1 : a.index > b.index ? 1 : 0))
      .map((x) => x.ref);
  }

  async effectiveGasPrice(hash: `0x${string}`): Promise<bigint> {
    return (await this.client.getTransactionReceipt({ hash })).effectiveGasPrice;
  }
}

function stamp(b: { number: bigint | null; timestamp: bigint; baseFeePerGas?: bigint | null }): BlockStamp {
  if (b.number === null) throw new Error('pending block has no number');
  return { number: b.number, timestamp: b.timestamp, baseFeePerGas: b.baseFeePerGas ?? null };
}
