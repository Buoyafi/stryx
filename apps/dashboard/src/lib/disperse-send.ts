import type { DisperseContract } from '@stryx/chains';
import { encodeDisperseEther } from './disperse-abi';
import { ApiError } from './api';
import { isRefusal } from './mint-error';
import { REVERTED_ON_CHAIN } from './mint-ops';
import { redactUrls, shortError } from './short-error';
import { sumWei, weiToDecimalString } from './units';
import { WalletError, classifyWalletError, type WalletSession } from './wallet';

/** Per-recipient send state. */
export type ItemStatus = 'waiting' | 'signing' | 'pending' | 'confirmed' | 'failed' | 'unconfirmed' | 'not_sent';

export interface SendItem {
  address: string;
  wei: bigint;
  status: ItemStatus;
  hash?: string;
  /** Short and free of URLs. */
  error?: string;
}

export interface SendTarget {
  address: string;
  wei: bigint;
}

const initial = (targets: readonly SendTarget[], status: ItemStatus = 'waiting'): SendItem[] => targets.map((t) => ({ ...t, status }));

/** Every recipient has an end state and all of them are confirmed. */
export const allConfirmed = (items: readonly SendItem[]): boolean => items.length > 0 && items.every((i) => i.status === 'confirmed');
export const isFinished = (items: readonly SendItem[]): boolean => items.every((i) => i.status === 'confirmed' || i.status === 'failed' || i.status === 'not_sent' || i.status === 'unconfirmed');

interface ConnectedInput {
  session: WalletSession;
  from: string;
  targets: readonly SendTarget[];
  onUpdate: (items: SendItem[]) => void;
  pollMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** The chain these transfers are meant for. When set, the wallet is checked before every signature. */
  chainId?: number;
}

/** ONE transaction through the chain's disperse contract. */
export async function sendViaContract(input: ConnectedInput & { contract: DisperseContract }): Promise<SendItem[]> {
  const { session, from, targets, contract, onUpdate } = input;
  let items = initial(targets, 'signing');
  onUpdate(items);
  const set = (patch: Partial<SendItem>) => {
    items = items.map((i) => ({ ...i, ...patch }));
    onUpdate(items);
  };

  let hash: string;
  try {
    hash = await session.sendTransaction({
      from,
      to: contract.address,
      value: sumWei(targets.map((t) => t.wei)),
      data: encodeDisperseEther(targets.map((t) => t.address), targets.map((t) => t.wei)),
    });
  } catch (err) {
    const e = classifyWalletError(err);
    set(e.kind === 'rejected' ? { status: 'not_sent', error: e.message } : { status: 'failed', error: e.message });
    return items;
  }

  set({ status: 'pending', hash });
  const outcome = await session.waitForReceipt(hash, { ...(input.pollMs !== undefined ? { intervalMs: input.pollMs } : {}), ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}), ...(input.signal ? { signal: input.signal } : {}) });
  set(outcome === 'success' ? { status: 'confirmed' } : outcome === 'reverted' ? { status: 'failed', error: REVERTED_ON_CHAIN } : { status: 'unconfirmed' });
  return items;
}

/** One plain transfer per recipient, each signed in the wallet, one after another. */
export async function sendSequentially(input: ConnectedInput): Promise<SendItem[]> {
  const { session, from, targets, onUpdate } = input;
  let items = initial(targets);
  const update = (index: number, patch: Partial<SendItem>) => {
    items = items.map((it, i) => (i === index ? { ...it, ...patch } : it));
    onUpdate(items);
  };
  const stopFrom = (start: number, reason: string) => {
    for (let j = start; j < targets.length; j++) update(j, { status: 'not_sent', error: reason });
  };
  onUpdate(items);

  for (let i = 0; i < targets.length; i++) {
    if (input.signal?.aborted) break;
    // A wallet switched to another network mid-batch would sign the rest there, in that chain's coin.
    if (input.chainId !== undefined && !(await onChain(session, input.chainId))) {
      stopFrom(i, 'Not sent: your wallet changed network.');
      break;
    }
    update(i, { status: 'signing' });
    let hash: string;
    try {
      hash = await session.sendTransaction({ from, to: targets[i]!.address, value: targets[i]!.wei });
    } catch (err) {
      const e: WalletError = classifyWalletError(err);
      update(i, e.kind === 'rejected' ? { status: 'not_sent', error: e.message } : { status: 'failed', error: e.message });
      stopFrom(i + 1, e.kind === 'rejected' ? 'Not sent: you rejected an earlier one.' : 'Not sent: stopped after an error.');
      break;
    }
    update(i, { status: 'pending', hash });
    const outcome = await session.waitForReceipt(hash, { ...(input.pollMs !== undefined ? { intervalMs: input.pollMs } : {}), ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}), ...(input.signal ? { signal: input.signal } : {}) });
    update(i, outcome === 'success' ? { status: 'confirmed' } : outcome === 'reverted' ? { status: 'failed', error: REVERTED_ON_CHAIN } : { status: 'unconfirmed' });
    if (outcome === 'timeout') {
      stopFrom(i + 1, 'Not sent: an earlier transfer had not confirmed.');
      break;
    }
  }
  return items;
}

async function onChain(session: Pick<WalletSession, 'chainId'>, expected: number): Promise<boolean> {
  try {
    return (await session.chainId()) === expected;
  } catch {
    return false;
  }
}

/** What the server's POST /wallets/disperse returns per recipient. 'unknown': it may have gone out; the hash says. */
export interface ServerDisperseOutcome {
  ok: boolean;
  haltReason?: string;
  results: { address: string; amount: string; status: 'sent' | 'failed' | 'unknown'; hash?: string; error?: string }[];
}

const NO_ANSWER = 'No answer from the server. Check the wallet before sending again.';

/** `dropped`: no receipt, and the chain no longer has the transaction. `unknown`: no receipt, it may still land. */
export type Receipt = { status: 'success' | 'reverted' | 'unknown' | 'dropped' };

const DROPPED = 'The network has no record of this transfer. It was not sent, so it is safe to send again.';

/** Sends from one of our wallets through the server, which signs and sends one transfer per recipient. */
export async function sendFromOurWallet(input: {
  request: (path: string, body: unknown) => Promise<ServerDisperseOutcome>;
  sourceWalletId: string;
  chainId: number;
  targets: readonly SendTarget[];
  track: (chainId: number, hashes: readonly string[], onReceipt: (hash: string, r: Receipt) => void) => Promise<void>;
  onUpdate: (items: SendItem[]) => void;
}): Promise<SendItem[]> {
  const { targets, onUpdate } = input;
  let items = initial(targets, 'signing');
  onUpdate(items);
  const patch = (fn: (i: SendItem) => SendItem) => {
    items = items.map(fn);
    onUpdate(items);
  };

  let outcome: ServerDisperseOutcome;
  try {
    outcome = await input.request('/wallets/disperse', {
      sourceWalletId: input.sourceWalletId,
      chainId: input.chainId,
      recipients: targets.map((t) => ({ address: t.address, amount: weiToDecimalString(t.wei) })),
    });
  } catch (err) {
    // The server sends one transfer after another inside this one request.
    if (!isRefusal(err)) {
      patch((i) => ({ ...i, status: 'unconfirmed', error: NO_ANSWER }));
      return items;
    }
    const refusal = (err as ApiError).body as { message?: string; error?: string } | null;
    const message = shortError(redactUrls(refusal?.message ?? refusal?.error ?? 'The request was refused.'), 120);
    patch((i) => ({ ...i, status: 'failed', error: message }));
    return items;
  }

  const byAddress = new Map(outcome.results.map((r) => [r.address.toLowerCase(), r]));
  patch((i) => {
    const r = byAddress.get(i.address.toLowerCase());
    if (!r) return { ...i, status: 'not_sent', error: outcome.haltReason ? `Not attempted: ${outcome.haltReason.replace(/_/g, ' ')}.` : 'Not attempted.' };
    if ((r.status === 'sent' || r.status === 'unknown') && r.hash) return { ...i, status: 'pending', hash: r.hash };
    if (r.status === 'unknown') return { ...i, status: 'unconfirmed', error: NO_ANSWER };
    return { ...i, status: 'failed', error: shortError(redactUrls(r.error ?? 'Failed before sending.'), 120) };
  });

  const hashes = items.flatMap((i) => (i.status === 'pending' && i.hash ? [i.hash] : []));
  if (hashes.length > 0) {
    await input.track(input.chainId, hashes, (hash, r) =>
      patch((i) => {
        if (i.hash?.toLowerCase() !== hash.toLowerCase()) return i;
        if (r.status === 'success') return { ...i, status: 'confirmed' };
        if (r.status === 'reverted') return { ...i, status: 'failed', error: REVERTED_ON_CHAIN };
        if (r.status === 'dropped') return { ...i, status: 'not_sent', error: DROPPED };
        return { ...i, status: 'unconfirmed' };
      }),
    );
  }
  return items;
}
