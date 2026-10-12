// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ApiError } from '../src/lib/api';
import { WalletError, WalletSession, classifyWalletError, discoverWallets, verifyDisperseContract, type Eip1193Provider } from '../src/lib/wallet';
import { allConfirmed, isFinished, sendFromOurWallet, sendSequentially, sendViaContract, type SendItem } from '../src/lib/disperse-send';
import { encodeDisperseEther } from '../src/lib/disperse-abi';
import { REVERTED_ON_CHAIN } from '../src/lib/mint-ops';

const A = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', B = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', C = '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB';
const FROM = '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb';
const ETH = 10n ** 18n;
const hashN = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const CONTRACT = { address: '0xD152f549545093347A162Dce210e7293f1452150', codeHash: '0x' + '1'.repeat(64) };
const SECRET = 'https://rpc.provider.io/v2/SUPERSECRETKEY';

/** A scripted wallet: each method is a handler; every call is recorded. */
function fakeWallet(handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>) {
  const calls: { method: string; params: unknown }[] = [];
  const provider: Eip1193Provider = {
    async request({ method, params }) {
      calls.push({ method, params });
      const h = handlers[method];
      if (!h) throw { code: -32601, message: `unhandled ${method}` };
      return h(params);
    },
  };
  return { provider, session: new WalletSession(provider), calls };
}
const noSleep = () => Promise.resolve();

describe('discoverWallets (EIP-6963)', () => {
  function fakeWindow(announcements: unknown[], ethereum?: unknown) {
    const listeners = new Set<(e: Event) => void>();
    return {
      ethereum,
      addEventListener: (_t: string, l: (e: Event) => void) => void listeners.add(l),
      removeEventListener: (_t: string, l: (e: Event) => void) => void listeners.delete(l),
      dispatchEvent: (e: Event) => {
        if (e.type === 'eip6963:requestProvider') for (const detail of announcements) for (const l of [...listeners]) l(new CustomEvent('eip6963:announceProvider', { detail }));
        return true;
      },
      listenerCount: () => listeners.size,
    };
  }
  const p1 = fakeWallet({}).provider, p2 = fakeWallet({}).provider;

  it('collects every wallet that announces itself, with its name, and only accepts a data: image for the icon', async () => {
    const win = fakeWindow([
      { info: { uuid: 'a', name: 'Rabby', icon: 'data:image/svg+xml;base64,AAAA', rdns: 'io.rabby' }, provider: p1 },
      { info: { uuid: 'b', name: 'Evil', icon: 'https://evil.example/x.png' }, provider: p2 },
    ]);
    const wallets = await discoverWallets({ win, waitMs: 0 });
    expect(wallets.map((w) => w.name)).toEqual(['Rabby', 'Evil']);
    expect(wallets[0]!.icon).toMatch(/^data:image\//);
    expect(wallets[1]!.icon).toBeUndefined(); // a remote icon URL would make the page fetch it
  });

  it('ignores a malformed announcement, and de-duplicates by uuid', async () => {
    const win = fakeWindow([{ info: { uuid: 'a', name: 'One' }, provider: p1 }, { info: { uuid: 'a', name: 'One again' }, provider: p1 }, { info: { uuid: 'x' }, provider: 'nope' }, null, {}]);
    expect((await discoverWallets({ win, waitMs: 0 })).map((w) => w.name)).toEqual(['One again']);
  });

  it('falls back to window.ethereum for a wallet that never announces, but does not list one that did twice', async () => {
    expect((await discoverWallets({ win: fakeWindow([], p1), waitMs: 0 })).map((w) => w.id)).toEqual(['window.ethereum']);
    expect((await discoverWallets({ win: fakeWindow([{ info: { uuid: 'a', name: 'Rabby' }, provider: p1 }], p1), waitMs: 0 })).map((w) => w.id)).toEqual(['a']);
    expect(await discoverWallets({ win: fakeWindow([]), waitMs: 0 })).toEqual([]);
  });

  it('names an old-style window.ethereum wallet from its flag, and skips it when that wallet also announced itself', async () => {
    const rabbyInjected = { ...fakeWallet({}).provider, isRabby: true, isMetaMask: true };
    const announcedRabby = { info: { uuid: 'r', name: 'Rabby Wallet', rdns: 'io.rabby' }, provider: p1 };
    expect((await discoverWallets({ win: fakeWindow([announcedRabby], rabbyInjected), waitMs: 0 })).map((w) => w.name)).toEqual(['Rabby Wallet']);
    const phantom = { ...fakeWallet({}).provider, isPhantom: true };
    const [only] = await discoverWallets({ win: fakeWindow([], phantom), waitMs: 0 });
    expect(only).toMatchObject({ id: 'window.ethereum', name: 'Phantom', rdns: 'app.phantom' });
  });

  it('stops listening once it is done', async () => {
    const win = fakeWindow([]);
    await discoverWallets({ win, waitMs: 0 });
    expect(win.listenerCount()).toBe(0);
  });
});

describe('classifyWalletError', () => {
  it('recognises a rejected signature, an unknown network and a busy wallet', () => {
    expect(classifyWalletError({ code: 4001, message: 'User rejected the request.' }).kind).toBe('rejected');
    expect(classifyWalletError({ message: 'MetaMask Tx Signature: User denied transaction signature.' }).kind).toBe('rejected');
    expect(classifyWalletError({ code: 4902, message: 'x' }).kind).toBe('unknown_chain');
    expect(classifyWalletError({ message: 'Unrecognized chain ID "0xb626"' }).kind).toBe('unknown_chain');
    expect(classifyWalletError({ code: -32002, message: 'x' }).kind).toBe('busy');
  });

  it('never lets an RPC URL through, and keeps the message short', () => {
    const e = classifyWalletError({ code: -32603, message: `HTTP request failed. URL: ${SECRET} ${'x'.repeat(500)}` });
    expect(e.kind).toBe('other');
    expect(e.message).not.toContain('SUPERSECRETKEY');
    expect(e.message.length).toBeLessThanOrEqual(121);
  });

  it('copes with a thrown non-object', () => {
    expect(classifyWalletError('boom').message.length).toBeGreaterThan(0);
    expect(classifyWalletError(null).kind).toBe('other');
    const e = new WalletError('busy', 'x');
    expect(classifyWalletError(e)).toBe(e);
  });
});

describe('WalletSession', () => {
  it('sends chain ids, values and calldata as hex quantities', async () => {
    const w = fakeWallet({ wallet_switchEthereumChain: () => null, eth_sendTransaction: () => hashN(1) });
    await w.session.switchChain(46630);
    await w.session.sendTransaction({ from: FROM, to: A, value: 2n * ETH, data: '0xabcd' });
    expect(w.calls[0]).toEqual({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xb626' }] });
    expect(w.calls[1]!.params).toEqual([{ from: FROM, to: A, value: '0x1bc16d674ec80000', data: '0xabcd' }]);
  });

  it('reads balance, gas price and chain id from hex, and rejects a malformed answer', async () => {
    const w = fakeWallet({ eth_getBalance: () => '0xde0b6b3a7640000', eth_gasPrice: () => '0x989680', eth_chainId: () => '0xb626', eth_estimateGas: () => 'garbage' });
    expect(await w.session.balance(FROM)).toBe(ETH);
    expect(await w.session.gasPrice()).toBe(10_000_000n);
    expect(await w.session.chainId()).toBe(46630);
    await expect(w.session.estimateGas({ from: FROM, to: A })).rejects.toBeInstanceOf(WalletError);
  });

  it('refuses a transaction answer that is not a 32-byte hash', async () => {
    const w = fakeWallet({ eth_sendTransaction: () => '0x1234' });
    await expect(w.session.sendTransaction({ from: FROM, to: A })).rejects.toThrow(/transaction hash/);
  });

  it('turns a provider rejection into a WalletError of the right kind', async () => {
    const w = fakeWallet({ eth_sendTransaction: () => { throw { code: 4001, message: 'User rejected' }; } });
    await expect(w.session.sendTransaction({ from: FROM, to: A })).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('maps receipts: 0x1 success, 0x0 reverted, null not yet', async () => {
    const answers: unknown[] = [null, { status: '0x1' }, { status: '0x0' }];
    const w = fakeWallet({ eth_getTransactionReceipt: () => answers.shift() });
    expect(await w.session.receipt(hashN(1))).toBeNull();
    expect(await w.session.receipt(hashN(1))).toBe('success');
    expect(await w.session.receipt(hashN(1))).toBe('reverted');
  });

  it('waitForReceipt polls until mined, tolerates a read error, and gives up at the deadline', async () => {
    let n = 0;
    const flaky = fakeWallet({ eth_getTransactionReceipt: () => { n++; if (n === 1) throw new Error('rpc hiccup'); return n < 4 ? null : { status: '0x1' }; } });
    expect(await flaky.session.waitForReceipt(hashN(1), { sleep: noSleep, intervalMs: 1 })).toBe('success');
    expect(n).toBe(4);

    let t = 0;
    const never = fakeWallet({ eth_getTransactionReceipt: () => null });
    expect(await never.session.waitForReceipt(hashN(1), { sleep: async (ms) => void (t += ms), now: () => t, intervalMs: 1000, timeoutMs: 5000 })).toBe('timeout');
    expect(never.calls.length).toBeGreaterThan(2);
    expect(never.calls.length).toBeLessThan(10);
  });

  it('waitForReceipt stops when aborted', async () => {
    const c = new AbortController();
    c.abort();
    const w = fakeWallet({ eth_getTransactionReceipt: () => null });
    expect(await w.session.waitForReceipt(hashN(1), { signal: c.signal, sleep: noSleep })).toBe('timeout');
    expect(w.calls).toHaveLength(0);
  });
});

describe('verifyDisperseContract: proving the right contract is at the address', () => {
  const code = '0x6080604052' + 'ab'.repeat(40);
  const codeHash = '0x' + Array.from(keccak_256(Uint8Array.from(code.slice(2).match(/.{2}/g)!.map((b) => parseInt(b, 16)))), (b) => b.toString(16).padStart(2, '0')).join('');
  const pinned = { address: CONTRACT.address, codeHash };

  it('passes only when the deployed code hashes to the pinned value', async () => {
    expect(await verifyDisperseContract({ getCode: async () => code }, pinned)).toEqual({ ok: true });
    expect(await verifyDisperseContract({ getCode: async () => code.toUpperCase().replace('0X', '0x') }, { ...pinned, codeHash: codeHash.toUpperCase().replace('0X', '0x') })).toEqual({ ok: true });
  });

  it('fails on a different contract, on no code, and when the code cannot be read', async () => {
    expect(await verifyDisperseContract({ getCode: async () => code + '00' }, pinned)).toEqual({ ok: false, reason: 'mismatch' });
    expect(await verifyDisperseContract({ getCode: async () => '0x' }, pinned)).toEqual({ ok: false, reason: 'no_code' });
    expect(await verifyDisperseContract({ getCode: async () => { throw new Error('x'); } }, pinned)).toEqual({ ok: false, reason: 'unreadable' });
  });
});

const targets = [{ address: A, wei: ETH / 100n }, { address: B, wei: ETH / 50n }, { address: C, wei: ETH / 10n }];

describe('sendViaContract: one transaction, one signature, all or nothing', () => {
  it('sends ONE transaction to the contract with the total as value and the encoded call, then confirms every recipient', async () => {
    const w = fakeWallet({ eth_sendTransaction: () => hashN(7), eth_getTransactionReceipt: () => ({ status: '0x1' }) });
    const seen: string[][] = [];
    const items = await sendViaContract({ session: w.session, from: FROM, targets, contract: CONTRACT, onUpdate: (i) => seen.push(i.map((x) => x.status)), pollMs: 1 });
    const sends = w.calls.filter((c) => c.method === 'eth_sendTransaction');
    expect(sends).toHaveLength(1);
    expect(sends[0]!.params).toEqual([{ from: FROM, to: CONTRACT.address, value: '0x' + (ETH / 100n + ETH / 50n + ETH / 10n).toString(16), data: encodeDisperseEther(targets.map((t) => t.address), targets.map((t) => t.wei)) }]);
    expect(items.map((i) => i.status)).toEqual(['confirmed', 'confirmed', 'confirmed']);
    expect(items.every((i) => i.hash === hashN(7))).toBe(true);
    expect(seen.map((s) => s[0])).toEqual(['signing', 'pending', 'confirmed']);
    expect(allConfirmed(items)).toBe(true);
  });

  it('a revert fails every recipient, with the honest "reason not available" text', async () => {
    const w = fakeWallet({ eth_sendTransaction: () => hashN(7), eth_getTransactionReceipt: () => ({ status: '0x0' }) });
    const items = await sendViaContract({ session: w.session, from: FROM, targets, contract: CONTRACT, onUpdate: () => {}, pollMs: 1 });
    expect(items.every((i) => i.status === 'failed' && i.error === REVERTED_ON_CHAIN)).toBe(true);
  });

  it('a rejected signature means nothing was sent (not "failed")', async () => {
    const w = fakeWallet({ eth_sendTransaction: () => { throw { code: 4001, message: 'User rejected' }; } });
    const items = await sendViaContract({ session: w.session, from: FROM, targets, contract: CONTRACT, onUpdate: () => {} });
    expect(items.every((i) => i.status === 'not_sent')).toBe(true);
    expect(items[0]!.error).toMatch(/rejected/i);
    expect(items[0]!.hash).toBeUndefined();
  });

  it('a wallet error fails them, with no URL in the message', async () => {
    const w = fakeWallet({ eth_sendTransaction: () => { throw { code: -32603, message: `failed at ${SECRET}` }; } });
    const items = await sendViaContract({ session: w.session, from: FROM, targets, contract: CONTRACT, onUpdate: () => {} });
    expect(items.every((i) => i.status === 'failed')).toBe(true);
    expect(JSON.stringify(items, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('SUPERSECRETKEY');
  });

  it('marks them unconfirmed (not failed) when no receipt arrives in time', async () => {
    const w = fakeWallet({ eth_sendTransaction: () => hashN(7), eth_getTransactionReceipt: () => null });
    const items = await sendViaContract({ session: w.session, from: FROM, targets, contract: CONTRACT, onUpdate: () => {}, pollMs: 1, timeoutMs: 0 });
    expect(items.every((i) => i.status === 'unconfirmed' && i.hash === hashN(7))).toBe(true);
  });
});

describe('sendSequentially: one signature per recipient', () => {
  it('sends each recipient its own amount, in order, and confirms them', async () => {
    let n = 0;
    const w = fakeWallet({ eth_sendTransaction: () => hashN(++n), eth_getTransactionReceipt: () => ({ status: '0x1' }) });
    const items = await sendSequentially({ session: w.session, from: FROM, targets, onUpdate: () => {}, pollMs: 1 });
    const sends = w.calls.filter((c) => c.method === 'eth_sendTransaction').map((c) => (c.params as { to: string; value: string }[])[0]!);
    expect(sends.map((s) => s.to)).toEqual([A, B, C]);
    expect(sends.map((s) => BigInt(s.value))).toEqual(targets.map((t) => t.wei));
    expect(items.map((i) => i.status)).toEqual(['confirmed', 'confirmed', 'confirmed']);
    expect(items.map((i) => i.hash)).toEqual([hashN(1), hashN(2), hashN(3)]);
  });

  it('waits for each transaction to be mined BEFORE asking for the next signature (a live testnet run hit a stale-nonce failure when it did not)', async () => {
    const order: string[] = [];
    let sent = 0;
    const looks = new Map<number, number>();
    const w = fakeWallet({
      eth_sendTransaction: () => { order.push(`sign${++sent}`); return hashN(sent); },
      // a transaction becomes visible as mined only on the second look
      eth_getTransactionReceipt: (p) => {
        const idx = Number(BigInt((p as string[])[0]!));
        const seen = (looks.get(idx) ?? 0) + 1;
        looks.set(idx, seen);
        if (seen < 2) { order.push(`unmined${idx}`); return null; }
        order.push(`mined${idx}`);
        return { status: '0x1' };
      },
    });
    await sendSequentially({ session: w.session, from: FROM, targets, onUpdate: () => {}, pollMs: 1 });
    expect(order.indexOf('mined1')).toBeLessThan(order.indexOf('sign2'));
    expect(order.indexOf('mined2')).toBeLessThan(order.indexOf('sign3'));
  });

  it('STOPS at a transaction that never confirms in time: the rest are not sent, not signed for', async () => {
    let n = 0;
    const w = fakeWallet({ eth_sendTransaction: () => hashN(++n), eth_getTransactionReceipt: () => null });
    const items = await sendSequentially({ session: w.session, from: FROM, targets, onUpdate: () => {}, pollMs: 1, timeoutMs: 0 });
    expect(items.map((i) => i.status)).toEqual(['unconfirmed', 'not_sent', 'not_sent']);
    expect(items[1]!.error).toMatch(/had not confirmed/);
    expect(w.calls.filter((c) => c.method === 'eth_sendTransaction')).toHaveLength(1);
  });

  it('STOPS at a rejected signature: earlier ones stay as they are, the rest are "not sent"', async () => {
    let n = 0;
    const w = fakeWallet({
      eth_sendTransaction: () => { n++; if (n === 2) throw { code: 4001, message: 'User rejected' }; return hashN(n); },
      eth_getTransactionReceipt: () => ({ status: '0x1' }),
    });
    const items = await sendSequentially({ session: w.session, from: FROM, targets, onUpdate: () => {}, pollMs: 1 });
    expect(items.map((i) => i.status)).toEqual(['confirmed', 'not_sent', 'not_sent']);
    expect(items[2]!.error).toMatch(/rejected an earlier/i);
    expect(w.calls.filter((c) => c.method === 'eth_sendTransaction')).toHaveLength(2); // it did not prompt for the third
  });

  it('STOPS at any other send error too, instead of prompting again for something that will fail the same way', async () => {
    let n = 0;
    const w = fakeWallet({ eth_sendTransaction: () => { n++; if (n === 1) throw { code: -32000, message: 'insufficient funds for gas' }; return hashN(n); }, eth_getTransactionReceipt: () => ({ status: '0x1' }) });
    const items = await sendSequentially({ session: w.session, from: FROM, targets, onUpdate: () => {}, pollMs: 1 });
    expect(items.map((i) => i.status)).toEqual(['failed', 'not_sent', 'not_sent']);
    expect(items[1]!.error).toMatch(/stopped after an error/i);
  });

  it('reports each recipient separately when one reverts on-chain', async () => {
    let n = 0;
    const w = fakeWallet({ eth_sendTransaction: () => hashN(++n), eth_getTransactionReceipt: (p) => ({ status: (p as string[])[0] === hashN(2) ? '0x0' : '0x1' }) });
    const items = await sendSequentially({ session: w.session, from: FROM, targets, onUpdate: () => {}, pollMs: 1 });
    expect(items.map((i) => i.status)).toEqual(['confirmed', 'failed', 'confirmed']);
    expect(allConfirmed(items)).toBe(false);
    expect(isFinished(items)).toBe(true);
  });

  it('emits an update at every step, never mutating what it already emitted', async () => {
    let n = 0;
    const w = fakeWallet({ eth_sendTransaction: () => hashN(++n), eth_getTransactionReceipt: () => ({ status: '0x1' }) });
    const snapshots: SendItem[][] = [];
    await sendSequentially({ session: w.session, from: FROM, targets: targets.slice(0, 2), onUpdate: (i) => snapshots.push(i), pollMs: 1 });
    expect(snapshots.length).toBeGreaterThan(4);
    expect(snapshots[0]!.map((i) => i.status)).toEqual(['waiting', 'waiting']);
    expect(new Set(snapshots).size).toBe(snapshots.length); // each snapshot is its own array
  });
});

describe('sendSequentially: the wallet is checked before every signature', () => {
  it('stops at the first recipient once the wallet is on another network; nothing more is signed', async () => {
    let n = 0;
    let network = '0x1';
    const w = fakeWallet({
      eth_chainId: () => network,
      eth_sendTransaction: () => {
        network = '0x89'; // the wallet is switched right after the first signature
        return hashN(++n);
      },
      eth_getTransactionReceipt: () => ({ status: '0x1' }),
    });
    const items = await sendSequentially({ session: w.session, from: FROM, targets, onUpdate: () => {}, pollMs: 1, chainId: 1 });
    expect(items.map((i) => i.status)).toEqual(['confirmed', 'not_sent', 'not_sent']);
    expect(items[1]!.error).toMatch(/changed network/);
    expect(w.calls.filter((c) => c.method === 'eth_sendTransaction')).toHaveLength(1);
  });
});

describe('sendFromOurWallet: through the existing server route', () => {
  const okOutcome = { ok: true, results: targets.map((t, i) => ({ address: t.address, amount: 'x', status: 'sent' as const, hash: hashN(i + 1) })) };

  it('sends per-recipient decimal amounts, then follows confirmations from the receipts', async () => {
    const request = vi.fn(async () => okOutcome);
    const track = vi.fn(async (_c: number, hashes: readonly string[], on: (h: string, r: { status: 'success' | 'reverted' | 'unknown' }) => void) => {
      on(hashes[0]!, { status: 'success' });
      on(hashes[1]!, { status: 'reverted' });
      on(hashes[2]!, { status: 'unknown' });
    });
    const items = await sendFromOurWallet({ request, sourceWalletId: 'w1', chainId: 46630, targets, track, onUpdate: () => {} });
    expect(request).toHaveBeenCalledWith('/wallets/disperse', {
      sourceWalletId: 'w1', chainId: 46630,
      recipients: [{ address: A, amount: '0.01' }, { address: B, amount: '0.02' }, { address: C, amount: '0.1' }],
    });
    expect(items.map((i) => i.status)).toEqual(['confirmed', 'failed', 'unconfirmed']);
    expect(items[1]!.error).toBe(REVERTED_ON_CHAIN);
    expect(track).toHaveBeenCalledWith(46630, [hashN(1), hashN(2), hashN(3)], expect.any(Function));
  });

  it('a transfer the chain no longer has is shown as not sent, safe to send again, and keeps its hash', async () => {
    const request = vi.fn(async () => okOutcome);
    const track = async (_c: number, hashes: readonly string[], on: (h: string, r: { status: 'success' | 'dropped' | 'unknown' }) => void) => {
      on(hashes[0]!, { status: 'success' });
      on(hashes[1]!, { status: 'dropped' });
      on(hashes[2]!, { status: 'unknown' });
    };
    const items = await sendFromOurWallet({ request, sourceWalletId: 'w1', chainId: 1, targets, track, onUpdate: () => {} });
    expect(items.map((i) => i.status)).toEqual(['confirmed', 'not_sent', 'unconfirmed']);
    expect(items[1]!.error).toMatch(/no record of this transfer.*safe to send again/);
    expect(items[1]!.hash).toBe(hashN(2));
    expect(items[2]!.error).toBeUndefined();
  });

  it('maps a recipient that failed before broadcast to failed, with a short URL-free reason, and does not track it', async () => {
    const request = async () => ({ ok: false, results: [{ address: A, amount: 'x', status: 'failed' as const, error: `boom ${SECRET}` }, ...okOutcome.results.slice(1)] });
    const track = vi.fn(async () => {});
    const items = await sendFromOurWallet({ request, sourceWalletId: 'w1', chainId: 1, targets, track, onUpdate: () => {} });
    expect(items[0]!.status).toBe('failed');
    expect(items[0]!.error).not.toContain('SUPERSECRETKEY');
    expect(track).toHaveBeenCalledWith(1, [hashN(2), hashN(3)], expect.any(Function));
  });

  it('marks recipients the server never attempted (a halted batch) as not sent, with the reason', async () => {
    const request = async () => ({ ok: false, haltReason: 'spending_cap_exceeded', results: [okOutcome.results[0]!] });
    const items = await sendFromOurWallet({ request, sourceWalletId: 'w1', chainId: 1, targets, track: async () => {}, onUpdate: () => {} });
    expect(items.map((i) => i.status)).toEqual(['pending', 'not_sent', 'not_sent']);
    expect(items[1]!.error).toBe('Not attempted: spending cap exceeded.');
  });

  it('a request that dies is NOT "failed": the server may still be sending, so every row says to check first', async () => {
    const request = async () => { throw new Error(`HTTP request failed. URL: ${SECRET}`); };
    const items = await sendFromOurWallet({ request, sourceWalletId: 'w1', chainId: 1, targets, track: async () => {}, onUpdate: () => {} });
    expect(items.every((i) => i.status === 'unconfirmed')).toBe(true);
    expect(items[0]!.error).toMatch(/Check the wallet before sending again/);
    expect(JSON.stringify(items, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('SUPERSECRETKEY');
  });

  it('a crash on the server is treated the same way; a refusal it gave is a plain failure with its reason', async () => {
    const crash = async () => { throw new ApiError(500, { error: 'internal_server_error' }); };
    const crashed = await sendFromOurWallet({ request: crash, sourceWalletId: 'w1', chainId: 1, targets, track: async () => {}, onUpdate: () => {} });
    expect(crashed.every((i) => i.status === 'unconfirmed')).toBe(true);

    const refuse = async () => { throw new ApiError(409, { error: 'insufficient_balance', message: 'Source wallet holds 0.01 ETH but needs ~0.13 ETH.' }); };
    const refused = await sendFromOurWallet({ request: refuse, sourceWalletId: 'w1', chainId: 1, targets, track: async () => {}, onUpdate: () => {} });
    expect(refused.every((i) => i.status === 'failed')).toBe(true);
    expect(refused[0]!.error).toBe('Source wallet holds 0.01 ETH but needs ~0.13 ETH.');
  });

  it('a transfer the server could not confirm either way is followed by its hash like a sent one', async () => {
    const request = async () => ({ ok: false, results: [{ address: A, amount: 'x', status: 'unknown' as const, hash: hashN(9) }, ...okOutcome.results.slice(1)] });
    const track = vi.fn(async (_c: number, hashes: readonly string[], on: (h: string, r: { status: 'success' | 'reverted' | 'unknown' }) => void) => on(hashes[0]!, { status: 'unknown' }));
    const items = await sendFromOurWallet({ request, sourceWalletId: 'w1', chainId: 1, targets, track, onUpdate: () => {} });
    expect(track).toHaveBeenCalledWith(1, [hashN(9), hashN(2), hashN(3)], expect.any(Function));
    expect(items[0]).toMatchObject({ status: 'unconfirmed', hash: hashN(9) });
  });
});

describe('end states', () => {
  it('allConfirmed needs every recipient confirmed, and at least one', () => {
    const item = (status: SendItem['status']): SendItem => ({ address: A, wei: 1n, status });
    expect(allConfirmed([])).toBe(false);
    expect(allConfirmed([item('confirmed'), item('confirmed')])).toBe(true);
    expect(allConfirmed([item('confirmed'), item('pending')])).toBe(false);
    expect(isFinished([item('confirmed'), item('pending')])).toBe(false);
    expect(isFinished([item('failed'), item('not_sent'), item('unconfirmed')])).toBe(true);
  });
});
