import { encodeFunctionData, keccak256, parseAbi, parseEther, formatGwei, formatUnits } from 'viem';
import { SEADROP_ADDRESS } from '@stryx/nft-engine';
import { DISPERSE_ADDRESS, KNOWN_DISPERSE_CODE_HASHES } from '@stryx/chains';
import { withTimeout, describeFetchFailure } from '@stryx/utils';
import type { ChainDefinition } from './chain-registry.js';
import { describeBalanceError } from './balance.service.js';

/**
 * The read-only checks behind `npm run chains:doctor`: for every chain, is each configured RPC
 * endpoint really that chain and alive, and does everything Stryx does on it work there.
 */

/** The slice of a viem PublicClient the doctor uses. */
export interface DoctorClient {
  getChainId(): Promise<number>;
  getBlock(args: { blockTag: 'latest' }): Promise<{ number: bigint | null; timestamp: bigint }>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  getCode(args: { address: `0x${string}` }): Promise<`0x${string}` | undefined>;
  call(args: {
    account: `0x${string}`;
    to: `0x${string}`;
    data?: `0x${string}`;
    value: bigint;
    stateOverride: Array<{ address: `0x${string}`; balance: bigint }>;
  }): Promise<unknown>;
  getBalance(args: { address: `0x${string}` }): Promise<bigint>;
}

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}
export interface EndpointReport {
  slot: 'main' | 'fallback';
  envKey: string;
  host: string;
  checks: Check[];
}
export interface ChainReport {
  chainId: number;
  name: string;
  configured: boolean;
  endpoints: EndpointReport[];
  /** Checks of what Stryx does on the chain, through the first endpoint that answered. */
  checks: Check[];
}

export interface DoctorEndpoint {
  slot: 'main' | 'fallback';
  envKey: string;
  host: string;
  client: DoctorClient;
}

const DISPERSE_ABI = parseAbi(['function disperseEther(address[] recipients, uint256[] values) payable']);
/** A throwaway sender with no key anyone holds, funded only inside simulations. */
const SIM_SENDER = '0x5712000000000000000000000000000000005712' as const;
const SIM_RECIPIENTS = ['0x5712000000000000000000000000000000000001', '0x5712000000000000000000000000000000000002'] as const;
const SIM_FUNDS = parseEther('1000000');
const READ_TIMEOUT_MS = 8_000;
/** A quiet chain (no empty blocks, e.g. Robinhood) can go minutes without one; only a warning. */
const STALE_BLOCK_S = 300;

const bounded = <T>(p: Promise<T>, what: string) => withTimeout(p, READ_TIMEOUT_MS, what);
const errText = (err: unknown) => (err instanceof Error ? err.message.split('\n')[0]! : String(err)).replace(/https?:\/\/\S+/g, '<url>');

async function checkEndpoint(chain: ChainDefinition, ep: DoctorEndpoint, now: () => number): Promise<{ report: EndpointReport; alive: boolean }> {
  const checks: Check[] = [];
  let alive = false;
  const started = now();
  try {
    const id = await bounded(ep.client.getChainId(), 'chain id');
    const ms = now() - started;
    if (id === chain.chainId) {
      alive = true;
      checks.push({ name: 'chain id', status: 'ok', detail: `${id}, answered in ${ms} ms` });
    } else {
      checks.push({ name: 'chain id', status: 'fail', detail: `This URL is chain ${id}, not ${chain.name} (${chain.chainId}). Wrong URL in ${ep.envKey}.` });
    }
  } catch (err) {
    checks.push({ name: 'chain id', status: 'fail', detail: describeBalanceError(err, chain.name).replace('balance could not be read', 'RPC did not answer') + ` (${errText(err)})` });
  }
  if (alive) {
    try {
      const block = await bounded(ep.client.getBlock({ blockTag: 'latest' }), 'latest block');
      const age = Math.round(now() / 1000 - Number(block.timestamp));
      checks.push({
        name: 'latest block',
        status: age > STALE_BLOCK_S ? 'warn' : 'ok',
        detail: `#${block.number ?? '?'} , ${age}s old${age > STALE_BLOCK_S ? ' (old: a quiet chain, or a node behind)' : ''}`,
      });
    } catch (err) {
      checks.push({ name: 'latest block', status: 'fail', detail: errText(err) });
    }
  }
  return { report: { slot: ep.slot, envKey: ep.envKey, host: ep.host, checks }, alive };
}

async function simulate(client: DoctorClient, args: { to: `0x${string}`; data?: `0x${string}`; value: bigint }): Promise<Check['status'] | { error: string }> {
  try {
    await bounded(client.call({ account: SIM_SENDER, ...args, stateOverride: [{ address: SIM_SENDER, balance: SIM_FUNDS }] }), 'simulation');
    return 'ok';
  } catch (err) {
    return { error: errText(err) };
  }
}

/** Providers without state override support answer with an "unsupported"/"invalid params" error: not a chain problem. */
const noStateOverride = (e: string) => /state ?override|invalid (params|argument)|not supported|unsupported|method not found|too many arguments/i.test(e);

export async function diagnoseChain(
  chain: ChainDefinition,
  endpoints: readonly DoctorEndpoint[],
  opts: { address?: `0x${string}`; now?: () => number; price?: () => Promise<{ ok: true; usd: number } | { ok: false; reason: string } | null> } = {},
): Promise<ChainReport> {
  const now = opts.now ?? Date.now;
  const base = { chainId: chain.chainId, name: chain.name };
  if (endpoints.length === 0) return { ...base, configured: false, endpoints: [], checks: [] };

  const results = await Promise.all(endpoints.map((ep) => checkEndpoint(chain, ep, now)));
  const working = results.findIndex((r) => r.alive);
  const checks: Check[] = [];
  const reports = results.map((r) => r.report);
  if (working === -1) {
    checks.push({ name: 'chain', status: 'fail', detail: 'No configured endpoint answered as this chain: balances, Disperse and mints cannot work here.' });
    return { ...base, configured: true, endpoints: reports, checks };
  }
  if (endpoints.length === 1) {
    checks.push({ name: 'fallback', status: 'warn', detail: `No fallback set (${chain.rpcFallbackEnvKey}). Fine for balances; for time-critical mints add one from a different provider.` });
  }
  const client = endpoints[working]!.client;
  const sym = chain.nativeCurrency.symbol;

  try {
    const fees = await bounded(client.estimateFeesPerGas(), 'fees');
    const floor = chain.feeMarket.minPriorityFeeGwei;
    const tipGwei = Number(formatGwei(fees.maxPriorityFeePerGas));
    const policy = chain.feeMarket.tipAffectsOrdering ? 'tip setting shown on the mint page' : 'first come first served: no tip setting';
    checks.push({
      name: 'fees',
      status: floor !== null && tipGwei < floor ? 'warn' : 'ok',
      detail: `max fee ${formatGwei(fees.maxFeePerGas)} gwei, suggested tip ${formatGwei(fees.maxPriorityFeePerGas)} gwei; ${policy}${floor !== null ? `; sends are raised to the ${floor} gwei minimum` : ''}`,
    });
  } catch (err) {
    checks.push({ name: 'fees', status: 'fail', detail: `Could not read fees, so nothing can be sent: ${errText(err)}` });
  }

  if (opts.address) {
    try {
      const wei = await bounded(client.getBalance({ address: opts.address }), 'balance');
      checks.push({ name: 'balance', status: 'ok', detail: `${formatUnits(wei, chain.nativeCurrency.decimals)} ${sym} at ${opts.address}` });
    } catch (err) {
      checks.push({ name: 'balance', status: 'fail', detail: describeBalanceError(err, chain.name) });
    }
  }

  if (opts.price) {
    const result = await opts.price().catch((err: unknown) => ({ ok: false as const, reason: errText(err) }));
    checks.push(
      result === null
        ? chain.chainId === 4663 || chain.chainId === 46630
          ? { name: 'price', status: 'skip', detail: "none by design: Robinhood Chain's ETH is not Ethereum's" }
          : { name: 'price', status: 'warn', detail: `no price mapping for ${sym}: USD is hidden` }
        : result.ok
          ? { name: 'price', status: 'ok', detail: `$${result.usd} per ${sym} (USD toggle and cost estimates)` }
          : { name: 'price', status: 'warn', detail: `no USD price for ${sym}: ${result.reason}. Amounts still work; USD is hidden.` },
    );
  }

  const transfer = await simulate(client, { to: SIM_RECIPIENTS[0], value: parseEther('0.001') });
  checks.push(
    transfer === 'ok'
      ? { name: 'plain transfer', status: 'ok', detail: 'simulated: Disperse from our wallets (one transfer per recipient) works here' }
      : typeof transfer === 'object' && noStateOverride(transfer.error)
        ? { name: 'plain transfer', status: 'skip', detail: 'this provider cannot simulate with a funded test address (no state override); not a chain problem' }
        : { name: 'plain transfer', status: 'fail', detail: `simulated transfer failed: ${typeof transfer === 'object' ? transfer.error : transfer}` },
  );

  const contract = chain.disperseContract;
  if (!contract) {
    // Nothing pinned yet: look for Disperse.app at its usual address and say whether its code is a
    // build already verified elsewhere.
    try {
      const code = await bounded(client.getCode({ address: DISPERSE_ADDRESS as `0x${string}` }), 'disperse code');
      if (!code || code === '0x') {
        checks.push({ name: 'disperse contract', status: 'skip', detail: 'none on this chain: a connected wallet sends one transfer per recipient' });
      } else {
        const hash = keccak256(code).toLowerCase();
        const known = KNOWN_DISPERSE_CODE_HASHES.includes(hash);
        checks.push({
          name: 'disperse contract',
          status: 'skip',
          detail: known
            ? `found at ${DISPERSE_ADDRESS} and its code (${hash}) is a verified Disperse build: send this line to have it enabled for this chain`
            : `code at ${DISPERSE_ADDRESS} (${hash}) is NOT a known Disperse build: left disabled`,
        });
      }
    } catch (err) {
      checks.push({ name: 'disperse contract', status: 'skip', detail: `none listed, and the usual address could not be read: ${errText(err)}` });
    }
  } else {
    try {
      const code = await bounded(client.getCode({ address: contract.address as `0x${string}` }), 'disperse code');
      if (!code || code === '0x') {
        checks.push({ name: 'disperse contract', status: 'fail', detail: `no code at ${contract.address} on this chain: the registry entry is wrong` });
      } else if (keccak256(code).toLowerCase() !== contract.codeHash.toLowerCase()) {
        checks.push({ name: 'disperse contract', status: 'fail', detail: `code at ${contract.address} is not the verified Disperse code (hash ${keccak256(code)}): the dashboard falls back to one transfer per recipient` });
      } else {
        const data = encodeFunctionData({ abi: DISPERSE_ABI, functionName: 'disperseEther', args: [[...SIM_RECIPIENTS], [parseEther('0.001'), parseEther('0.002')]] });
        const sim = await simulate(client, { to: contract.address as `0x${string}`, data, value: parseEther('0.003') });
        checks.push(
          sim === 'ok'
            ? { name: 'disperse contract', status: 'ok', detail: `verified code at ${contract.address}; a 2-recipient disperseEther simulates cleanly` }
            : typeof sim === 'object' && noStateOverride(sim.error)
              ? { name: 'disperse contract', status: 'ok', detail: `verified code at ${contract.address} (this provider cannot run the funded simulation)` }
              : { name: 'disperse contract', status: 'fail', detail: `verified code, but a simulated disperseEther failed: ${typeof sim === 'object' ? sim.error : sim}` },
        );
      }
    } catch (err) {
      checks.push({ name: 'disperse contract', status: 'fail', detail: `could not read the contract: ${errText(err)}` });
    }
  }

  try {
    const code = await bounded(client.getCode({ address: SEADROP_ADDRESS }), 'SeaDrop code');
    checks.push(
      code && code !== '0x'
        ? { name: 'SeaDrop', status: 'ok', detail: `deployed at ${SEADROP_ADDRESS}: SeaDrop mints can work here` }
        : { name: 'SeaDrop', status: 'warn', detail: `not deployed at ${SEADROP_ADDRESS}: OpenSea drops on this chain do not use it, so minting here is not supported yet` },
    );
  } catch (err) {
    checks.push({ name: 'SeaDrop', status: 'fail', detail: `could not read: ${errText(err)}` });
  }

  return { ...base, configured: true, endpoints: reports, checks };
}

/** The minimal fetch the OpenSea check needs. */
export type DoctorFetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

/** Can this machine reach OpenSea's API, reliably? */
export async function checkOpenSea(fetchImpl: DoctorFetch, apiKey: string | undefined, now: () => number = Date.now, apiBase = 'https://api.opensea.io'): Promise<Check[]> {
  if (!apiKey) return [{ name: 'OpenSea', status: 'warn', detail: 'OPENSEA_API_KEY is not set: collection links, slugs and OpenSea phases cannot be read' }];
  const url = `${apiBase}/api/v2/chain/ethereum/contract/0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d`;
  const attempts: string[] = [];
  let ok = 0;
  let refused: number | null = null;
  for (let i = 0; i < 3; i++) {
    const started = now();
    try {
      const res = await fetchImpl(url, { headers: { accept: 'application/json', 'x-api-key': apiKey }, signal: AbortSignal.timeout(15_000) });
      const ms = now() - started;
      if (res.ok) {
        ok++;
        attempts.push(`${ms} ms`);
      } else {
        refused = res.status;
        attempts.push(`HTTP ${res.status} in ${ms} ms`);
      }
    } catch (err) {
      const ms = now() - started;
      const why = err instanceof Error && err.name === 'TimeoutError' ? 'no answer within 15s' : describeFetchFailure(err);
      attempts.push(`failed after ${ms} ms: ${why}`);
    }
  }
  const detail = `${ok} of 3 requests answered (${attempts.join('; ')})`;
  if (refused === 401 || refused === 403) return [{ name: 'OpenSea', status: 'fail', detail: `${detail}. OpenSea refused the key: check OPENSEA_API_KEY.` }];
  if (refused === 429) return [{ name: 'OpenSea', status: 'warn', detail: `${detail}. Rate-limited: the key's request allowance is being used up.` }];
  if (ok === 3) return [{ name: 'OpenSea', status: 'ok', detail }];
  return [{ name: 'OpenSea', status: ok === 0 ? 'fail' : 'warn', detail: `${detail}. The network path from this machine to OpenSea is unreliable: see the reasons above.` }];
}

const MARK: Record<CheckStatus, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' };

/** Plain-text rendering, one block per chain; nothing here contains a URL beyond its host. */
export function formatDoctorReport(
  reports: readonly ChainReport[],
  extras: { misnamed: Array<{ key: string; didYouMean: string | null }>; spendCap?: string; openSea?: readonly Check[] },
): string {
  const lines: string[] = [];
  for (const c of extras.openSea ?? []) lines.push(`${MARK[c.status]} ${c.name}: ${c.detail}`);
  if ((extras.openSea ?? []).length > 0) lines.push('');
  for (const m of extras.misnamed) {
    lines.push(`FAIL ${m.key} is set but no chain reads it${m.didYouMean ? `: rename it to ${m.didYouMean}` : ''}.`);
  }
  if (extras.misnamed.length > 0) lines.push('');
  for (const r of reports) {
    if (!r.configured) {
      lines.push(`- ${r.name} (${r.chainId}): not configured`);
      continue;
    }
    lines.push(`- ${r.name} (${r.chainId})`);
    for (const e of r.endpoints) {
      lines.push(`    ${e.slot} ${e.envKey} -> ${e.host}`);
      for (const c of e.checks) lines.push(`      ${MARK[c.status]} ${c.name}: ${c.detail}`);
    }
    for (const c of r.checks) lines.push(`    ${MARK[c.status]} ${c.name}: ${c.detail}`);
  }
  if (extras.spendCap) lines.push('', extras.spendCap);
  const fails =
    [...(extras.openSea ?? []), ...reports.flatMap((r) => [...r.endpoints.flatMap((e) => e.checks), ...r.checks])].filter((c) => c.status === 'fail').length + extras.misnamed.length;
  lines.push('', fails === 0 ? 'No failures.' : `${fails} failure(s) above.`);
  return lines.join('\n');
}
