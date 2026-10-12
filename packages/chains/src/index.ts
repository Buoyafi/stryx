/**
 * The single source of truth for the chains Stryx knows: id, name, testnet or not, gas token, icon.
 * Data only; anything that depends on deployment config, such as an RPC URL, lives elsewhere.
 */
export interface NativeCurrency {
  name: string;
  symbol: string;
  decimals: number;
}

export interface Chain {
  chainId: number;
  name: string;
  /** OpenSea's name for this chain, or null where OpenSea does not support it. */
  openSeaChainName: string | null;
  /** Other names OpenSea URLs have used for this chain (Polygon: "polygon" as well as "matic"). */
  openSeaAliases?: readonly string[];
  isTestnet: boolean;
  nativeCurrency: NativeCurrency;
  icon: string | null;
  /** Base URL of the chain's block explorer (no trailing slash), or null if there is none. */
  explorerUrl: string | null;
  /** A single-transaction disperse contract on this chain, or null (then a batch is one transaction per recipient). */
  disperseContract: DisperseContract | null;
  /** How this chain prices and orders transactions; drives the priority-fee setting. */
  feeMarket: FeeMarket;
}

/** What a priority fee (the "tip") does on a chain. */
export interface FeeMarket {
  tipAffectsOrdering: boolean;
  minPriorityFeeGwei: number | null;
  /**
   * The chain charges for the gas LIMIT, not the gas used (Monad: it executes after ordering, so a
   * transaction pays for the space it reserved).
   */
  chargesGasLimit: boolean;
}

export interface DisperseContract {
  /** EIP-55 checksummed address. */
  address: string;
  /** keccak256 of the deployed runtime bytecode (0x-prefixed, lowercase hex). */
  codeHash: string;
}

/**
 * The contract is Disperse.app (0xD152f549545093347A162Dce210e7293f1452150), a widely used third-party
 * contract; it has NOT been audited by us.
 */
export const DISPERSE_CONTRACT_NOTE = 'Disperse.app, third-party and unaudited by Stryx. Verified on-chain per chain; see the comment above.';

export const DISPERSE_ADDRESS = '0xD152f549545093347A162Dce210e7293f1452150';
const disperse = (codeHash: string): DisperseContract => ({ address: DISPERSE_ADDRESS, codeHash });
const HASH_A = '0x65660051e320731a70b9ddcd5ec9fd4f565cf85e2f6caf0eb71589fb544b9996'; // Ethereum, Polygon, BNB Chain (BNB read by the chain doctor 2026-09-29)
const HASH_B = '0xc0a38c227d2c70248fc51ed0dd3a72df3adf5b41494c7f3cc19c16c38523244d'; // Base, Arbitrum One, Optimism
/**
 * Every Disperse.app runtime-code hash already verified on-chain: a new chain's code matching one of
 * these is the same contract.
 */
export const KNOWN_DISPERSE_CODE_HASHES: readonly string[] = [HASH_A, HASH_B];

const ETH: NativeCurrency = { name: 'Ether', symbol: 'ETH', decimals: 18 };
const POL: NativeCurrency = { name: 'POL', symbol: 'POL', decimals: 18 };

const BNB: NativeCurrency = { name: 'BNB', symbol: 'BNB', decimals: 18 };
const HYPE: NativeCurrency = { name: 'HYPE', symbol: 'HYPE', decimals: 18 };
const BERA: NativeCurrency = { name: 'BERA', symbol: 'BERA', decimals: 18 };
const MON: NativeCurrency = { name: 'MON', symbol: 'MON', decimals: 18 };
const AVAX: NativeCurrency = { name: 'Avalanche', symbol: 'AVAX', decimals: 18 };
const RON: NativeCurrency = { name: 'Ronin', symbol: 'RON', decimals: 18 };
/** Arc pays gas in USDC. */
const ARC_USDC: NativeCurrency = { name: 'USD Coin', symbol: 'USDC', decimals: 18 };

const TIP_ORDERED: FeeMarket = { tipAffectsOrdering: true, minPriorityFeeGwei: null, chargesGasLimit: false };
const FIRST_COME: FeeMarket = { tipAffectsOrdering: false, minPriorityFeeGwei: null, chargesGasLimit: false };
/**
 * How the tip is used on these chains is not confirmed, so no tip setting is offered. Sends still pay
 * the node's suggested fees.
 */
const TIP_UNVERIFIED: FeeMarket = FIRST_COME;

export const CHAINS = [
  { chainId: 4663, name: 'Robinhood Chain', openSeaChainName: 'robinhood', isTestnet: false, nativeCurrency: ETH, icon: 'icons/robinhood.svg', explorerUrl: 'https://robinhoodchain.blockscout.com', disperseContract: null, feeMarket: FIRST_COME },
  { chainId: 46630, name: 'Robinhood Chain Testnet', openSeaChainName: 'robinhood_testnet', isTestnet: true, nativeCurrency: ETH, icon: 'icons/robinhood.svg', explorerUrl: 'https://explorer.testnet.chain.robinhood.com', disperseContract: null, feeMarket: FIRST_COME },
  { chainId: 1, name: 'Ethereum', openSeaChainName: 'ethereum', isTestnet: false, nativeCurrency: ETH, icon: 'icons/ethereum.svg', explorerUrl: 'https://etherscan.io', disperseContract: disperse(HASH_A), feeMarket: TIP_ORDERED },
  { chainId: 8453, name: 'Base', openSeaChainName: 'base', isTestnet: false, nativeCurrency: ETH, icon: 'icons/base.svg', explorerUrl: 'https://basescan.org', disperseContract: disperse(HASH_B), feeMarket: TIP_ORDERED },
  { chainId: 42161, name: 'Arbitrum One', openSeaChainName: 'arbitrum', isTestnet: false, nativeCurrency: ETH, icon: 'icons/arbitrum-one.svg', explorerUrl: 'https://arbiscan.io', disperseContract: disperse(HASH_B), feeMarket: FIRST_COME },
  { chainId: 10, name: 'Optimism', openSeaChainName: 'optimism', isTestnet: false, nativeCurrency: ETH, icon: 'icons/optimism.svg', explorerUrl: 'https://optimistic.etherscan.io', disperseContract: disperse(HASH_B), feeMarket: TIP_ORDERED },
  { chainId: 137, name: 'Polygon', openSeaChainName: 'matic', isTestnet: false, nativeCurrency: POL, openSeaAliases: ['polygon'], icon: 'icons/polygon.svg', explorerUrl: 'https://polygonscan.com', disperseContract: disperse(HASH_A), feeMarket: { tipAffectsOrdering: true, minPriorityFeeGwei: 25, chargesGasLimit: false } },
  { chainId: 56, name: 'BNB Chain', openSeaChainName: null, isTestnet: false, nativeCurrency: BNB, icon: 'icons/bnb.svg', explorerUrl: 'https://bscscan.com', disperseContract: disperse(HASH_A), feeMarket: { tipAffectsOrdering: true, minPriorityFeeGwei: 0.05, chargesGasLimit: false } },
  { chainId: 999, name: 'HyperEVM', openSeaChainName: 'hyperevm', isTestnet: false, nativeCurrency: HYPE, icon: 'icons/hyperevm.svg', explorerUrl: 'https://hyperevmscan.io', disperseContract: null, feeMarket: TIP_UNVERIFIED },
  { chainId: 80094, name: 'Berachain', openSeaChainName: 'bera_chain', isTestnet: false, nativeCurrency: BERA, icon: 'icons/berachain.svg', explorerUrl: 'https://berascan.com', disperseContract: null, feeMarket: TIP_ORDERED },
  { chainId: 143, name: 'Monad', openSeaChainName: 'monad', isTestnet: false, nativeCurrency: MON, icon: 'icons/monad.svg', explorerUrl: 'https://monadscan.com', disperseContract: null, feeMarket: { tipAffectsOrdering: true, minPriorityFeeGwei: null, chargesGasLimit: true } },
  { chainId: 43114, name: 'Avalanche', openSeaChainName: 'avalanche', isTestnet: false, nativeCurrency: AVAX, icon: 'icons/avalanche.svg', explorerUrl: 'https://snowtrace.io', disperseContract: null, feeMarket: TIP_ORDERED },
  { chainId: 2741, name: 'Abstract', openSeaChainName: 'abstract', isTestnet: false, nativeCurrency: ETH, icon: 'icons/abstract.svg', explorerUrl: 'https://abscan.org', disperseContract: null, feeMarket: FIRST_COME },
  { chainId: 57073, name: 'Ink', openSeaChainName: null, isTestnet: false, nativeCurrency: ETH, icon: 'icons/ink.svg', explorerUrl: 'https://explorer.inkonchain.com', disperseContract: null, feeMarket: TIP_ORDERED },
  { chainId: 2020, name: 'Ronin', openSeaChainName: 'ronin', isTestnet: false, nativeCurrency: RON, icon: 'icons/ronin.svg', explorerUrl: 'https://app.roninchain.com', disperseContract: null, feeMarket: TIP_UNVERIFIED },
  { chainId: 5042, name: 'Arc', openSeaChainName: null, isTestnet: false, nativeCurrency: ARC_USDC, icon: 'icons/arc.svg', explorerUrl: 'https://arc-scan.io', disperseContract: null, feeMarket: TIP_UNVERIFIED },
] as const satisfies readonly Chain[];

/** Every chain id in the table, as a literal union, so consumers can require exhaustive per-chain config. */
export type KnownChainId = (typeof CHAINS)[number]['chainId'];

const BY_ID: ReadonlyMap<number, Chain> = new Map(CHAINS.map((c) => [c.chainId, c]));

export function chainById(chainId: number): Chain | undefined {
  return BY_ID.get(chainId);
}

/** "Mainnet" or "Testnet", for display. */
export function networkLabel(chain: Pick<Chain, 'isTestnet'>): 'Mainnet' | 'Testnet' {
  return chain.isTestnet ? 'Testnet' : 'Mainnet';
}

const TX_HASH = /^0x[a-fA-F0-9]{64}$/;

/** The explorer page for a transaction, or undefined when there is no explorer or the value is not a 32-byte hash. */
export function explorerTxUrl(chain: Pick<Chain, 'explorerUrl'>, hash: string): string | undefined {
  if (!chain.explorerUrl || !TX_HASH.test(hash)) return undefined;
  return `${chain.explorerUrl}/tx/${hash}`;
}
