import { keccak_256 } from '@noble/hashes/sha3.js';
import type { DisperseContract } from '@stryx/chains';
import { redactUrls, shortError } from './short-error';
import { identifyInjected } from './wallet-logos';

/** A browser wallet, spoken to through the standard EIP-1193 provider interface. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  /** Ends a remote session (WalletConnect); a browser extension has none. */
  disconnect?(): Promise<void>;
}

export interface DiscoveredWallet {
  id: string;
  name: string;
  /** A data: URI the wallet supplies for its own logo. */
  icon?: string;
  rdns?: string;
  provider: Eip1193Provider;
}

interface WindowLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  dispatchEvent(event: Event): boolean;
  ethereum?: unknown;
}

interface AnnounceDetail {
  info?: { uuid?: string; name?: string; icon?: string; rdns?: string };
  provider?: Eip1193Provider;
}

const isProvider = (v: unknown): v is Eip1193Provider => typeof v === 'object' && v !== null && typeof (v as Eip1193Provider).request === 'function';

export function discoverWallets(opts: { win?: WindowLike; waitMs?: number } = {}): Promise<DiscoveredWallet[]> {
  const win = opts.win ?? (typeof window !== 'undefined' ? (window as unknown as WindowLike) : undefined);
  if (!win) return Promise.resolve([]);
  const found = new Map<string, DiscoveredWallet>();

  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<AnnounceDetail>).detail;
    if (!detail || !isProvider(detail.provider)) return;
    const id = detail.info?.uuid ?? detail.info?.rdns ?? `wallet-${found.size}`;
    found.set(id, {
      id,
      name: detail.info?.name ?? 'Browser wallet',
      ...(detail.info?.icon?.startsWith('data:image/') ? { icon: detail.info.icon } : {}),
      ...(detail.info?.rdns ? { rdns: detail.info.rdns } : {}),
      provider: detail.provider,
    });
  };

  win.addEventListener('eip6963:announceProvider', onAnnounce);
  win.dispatchEvent(new Event('eip6963:requestProvider'));

  return new Promise((resolve) =>
    setTimeout(() => {
      win.removeEventListener('eip6963:announceProvider', onAnnounce);
      const wallets = [...found.values()];
      // A wallet that never announced itself is still reachable as window.ethereum.
      if (isProvider(win.ethereum) && !wallets.some((w) => w.provider === win.ethereum)) {
        const known = identifyInjected(win.ethereum);
        if (!known || !wallets.some((w) => w.rdns !== undefined && known.rdns.includes(w.rdns))) {
          wallets.push({ id: 'window.ethereum', name: known?.name ?? 'Browser wallet', ...(known ? { rdns: known.rdns[0]! } : {}), provider: win.ethereum });
        }
      }
      resolve(wallets);
    }, opts.waitMs ?? 150),
  );
}

export type WalletErrorKind = 'rejected' | 'unknown_chain' | 'busy' | 'other';

export class WalletError extends Error {
  constructor(
    public readonly kind: WalletErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

/** Turns whatever a wallet throws into something short and safe to show. */
export function classifyWalletError(err: unknown): WalletError {
  if (err instanceof WalletError) return err;
  const e = err as { code?: number; message?: string } | null;
  const code = e?.code;
  const raw = typeof e?.message === 'string' ? e.message : 'The wallet returned an error.';
  if (code === 4001 || /user (rejected|denied)|rejected the request/i.test(raw)) return new WalletError('rejected', 'You rejected the request in your wallet.');
  if (code === 4902 || /unrecognized chain|unknown chain|not been added/i.test(raw)) return new WalletError('unknown_chain', 'Your wallet does not have this network yet. Add it in your wallet, then try again.');
  if (code === -32002) return new WalletError('busy', 'Your wallet already has a request open. Finish or close it first.');
  return new WalletError('other', shortError(redactUrls(raw), 120) || 'The wallet returned an error.');
}

const hex = (n: bigint | number): string => `0x${BigInt(n).toString(16)}`;
const fromHex = (v: unknown): bigint => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) throw new WalletError('other', 'The wallet returned an unexpected value.');
  return v === '0x' ? 0n : BigInt(v);
};

export interface TxRequest {
  from: string;
  to: string;
  value?: bigint;
  data?: string;
}

export type ReceiptOutcome = 'success' | 'reverted' | 'timeout';

export class WalletSession {
  constructor(readonly provider: Eip1193Provider) {}

  private async call<T>(method: string, params?: unknown): Promise<T> {
    try {
      return (await this.provider.request({ method, ...(params !== undefined ? { params } : {}) })) as T;
    } catch (err) {
      throw classifyWalletError(err);
    }
  }

  async requestAccounts(): Promise<string[]> {
    const accounts = await this.call<unknown>('eth_requestAccounts');
    if (!Array.isArray(accounts)) throw new WalletError('other', 'The wallet returned no accounts.');
    return accounts.filter((a): a is string => typeof a === 'string');
  }

  async chainId(): Promise<number> {
    return Number(fromHex(await this.call<unknown>('eth_chainId')));
  }

  async switchChain(chainId: number): Promise<void> {
    await this.call('wallet_switchEthereumChain', [{ chainId: hex(chainId) }]);
  }

  async balance(address: string): Promise<bigint> {
    return fromHex(await this.call<unknown>('eth_getBalance', [address, 'latest']));
  }

  async gasPrice(): Promise<bigint> {
    return fromHex(await this.call<unknown>('eth_gasPrice'));
  }

  async estimateGas(tx: TxRequest): Promise<bigint> {
    return fromHex(await this.call<unknown>('eth_estimateGas', [txParams(tx)]));
  }

  async getCode(address: string): Promise<string> {
    const code = await this.call<unknown>('eth_getCode', [address, 'latest']);
    return typeof code === 'string' ? code : '0x';
  }

  /** Asks the wallet to sign a plain-text message (EIP-191 personal_sign), used for sign-in. */
  async signMessage(address: string, message: string): Promise<string> {
    const data = toHexString(new TextEncoder().encode(message));
    const signature = await this.call<unknown>('personal_sign', [data, address]);
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130,}$/.test(signature)) throw new WalletError('other', 'The wallet did not return a signature.');
    return signature;
  }

  /** Asks the wallet to sign and send. Resolves with the transaction hash as soon as the wallet has broadcast it. */
  async sendTransaction(tx: TxRequest): Promise<string> {
    const hash = await this.call<unknown>('eth_sendTransaction', [txParams(tx)]);
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new WalletError('other', 'The wallet did not return a transaction hash.');
    return hash;
  }

  async receipt(hash: string): Promise<'success' | 'reverted' | null> {
    const r = await this.call<{ status?: string } | null>('eth_getTransactionReceipt', [hash]);
    if (!r) return null;
    return r.status === '0x1' ? 'success' : 'reverted';
  }

  async waitForReceipt(hash: string, opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; signal?: AbortSignal } = {}): Promise<ReceiptOutcome> {
    const { intervalMs = 2_000, timeoutMs = 180_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, signal } = opts;
    const deadline = now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) return 'timeout';
      try {
        const outcome = await this.receipt(hash);
        if (outcome) return outcome;
      } catch {
        // A hiccup reading the receipt is "not yet", not a failure: the deadline bounds it.
      }
      if (now() + intervalMs > deadline) return 'timeout';
      await sleep(intervalMs);
    }
  }
}

function txParams(tx: TxRequest): Record<string, string> {
  return { from: tx.from, to: tx.to, ...(tx.value !== undefined ? { value: hex(tx.value) } : {}), ...(tx.data ? { data: tx.data } : {}) };
}

const toBytes = (hexString: string): Uint8Array => Uint8Array.from((hexString.slice(2).match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
const toHexString = (bytes: Uint8Array): string => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;

export type ContractCheck = { ok: true } | { ok: false; reason: 'no_code' | 'mismatch' | 'unreadable' };

/**
 * Confirms the disperse contract a chain names is really there and is the verified code: the hash of
 * its deployed code must equal the pinned one.
 */
export async function verifyDisperseContract(session: Pick<WalletSession, 'getCode'>, contract: DisperseContract): Promise<ContractCheck> {
  let code: string;
  try {
    code = await session.getCode(contract.address);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (!code || code === '0x') return { ok: false, reason: 'no_code' };
  return toHexString(keccak_256(toBytes(code))) === contract.codeHash.toLowerCase() ? { ok: true } : { ok: false, reason: 'mismatch' };
}
