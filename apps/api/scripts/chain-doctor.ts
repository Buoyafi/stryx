#!/usr/bin/env -S npx tsx
/**
 * Checks every chain Stryx knows, through the RPC URLs in your .env: is each endpoint really that
 * chain and answering, and do balances, plain transfers, the Disperse contract and SeaDrop work there.
 * Read-only.
 */
/* eslint-disable no-console -- a CLI report: printing to stdout is its whole job. */
import 'dotenv/config';
import { createPublicClient, http, formatEther, type PublicClient } from 'viem';
import type { AppConfig } from '@stryx/config';
import { CHAIN_REGISTRY, rpcUrlFor, rpcFallbackUrlFor, testnetsSwitchedOff, unrecognizedRpcEnvKeys } from '../src/chain-registry.js';
import { checkOpenSea, diagnoseChain, formatDoctorReport, type DoctorClient, type DoctorEndpoint } from '../src/chain-doctor.js';
import { coinGeckoIdFor, fetchCoinGeckoUsd, fixedUsdFor, type CoinGeckoPriceResult } from '../src/native-price.service.js';
import { applyNetworkDefaults } from '../src/network-defaults.js';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(not a valid URL)';
  }
}

function client(url: string): DoctorClient {
  return createPublicClient({ transport: http(url, { timeout: 8_000, retryCount: 0 }) }) as unknown as DoctorClient & PublicClient;
}

async function main(): Promise<void> {
  applyNetworkDefaults();
  const args = process.argv.slice(2);
  const i = args.indexOf('--address');
  const address = i >= 0 ? args[i + 1] : undefined;
  if (address !== undefined && !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    console.error('--address must be a 0x-prefixed 40-hex-character address.');
    process.exitCode = 1;
    return;
  }
  const config = process.env as unknown as AppConfig;
  // One request per price id, one at a time, a second apart: the keyless feed rate-limits a burst.
  const apiKey = process.env['COINGECKO_API_KEY'] || undefined;
  const byId = new Map<string, Promise<CoinGeckoPriceResult>>();
  let queue: Promise<unknown> = Promise.resolve();
  const priceFor = (chainId: number): Promise<CoinGeckoPriceResult | null> => {
    const fixed = fixedUsdFor(chainId);
    if (fixed !== undefined) return Promise.resolve({ ok: true, usd: fixed });
    const id = coinGeckoIdFor(chainId);
    if (!id) return Promise.resolve(null);
    let p = byId.get(id);
    if (!p) {
      p = queue.then(() => fetchCoinGeckoUsd((url, init) => fetch(url, init), id, { apiKey }));
      queue = p.then(() => new Promise((r) => setTimeout(r, apiKey ? 100 : 1_000)));
      byId.set(id, p);
    }
    return p;
  };

  const reports = await Promise.all(
    CHAIN_REGISTRY.map((chain) => {
      const endpoints: DoctorEndpoint[] = [];
      const main = rpcUrlFor(config, chain.chainId);
      const fallback = rpcFallbackUrlFor(config, chain.chainId);
      if (main) endpoints.push({ slot: 'main', envKey: String(chain.rpcEnvKey), host: hostOf(main), client: client(main) });
      if (fallback) endpoints.push({ slot: 'fallback', envKey: String(chain.rpcFallbackEnvKey), host: hostOf(fallback), client: client(fallback) });
      return diagnoseChain(chain, endpoints, { ...(address ? { address: address as `0x${string}` } : {}), price: () => priceFor(chain.chainId) });
    }),
  );

  const capRaw = process.env['DEFAULT_DAILY_SPEND_CAP_WEI'];
  const perChain = process.env['DEFAULT_DAILY_SPEND_CAPS'];
  const spendCap = [
    'Daily spend caps apply to signed-up accounts; the operator account is unlimited.',
    `  ETH-gas chains: ${capRaw ? `${formatEther(BigInt(capRaw))} ETH` : '1 ETH (built-in)'} per chain per day (DEFAULT_DAILY_SPEND_CAP_WEI).`,
    `  Other chains: ${perChain ? perChain : 'none set, so 0: a capped account sends nothing on them'} (DEFAULT_DAILY_SPEND_CAPS, chainId=amount in that chain's token).`,
  ].join('\n');

  const openSea = await checkOpenSea((url, init) => fetch(url, init), process.env['OPENSEA_API_KEY'] || undefined);
  console.log(formatDoctorReport(reports, { misnamed: unrecognizedRpcEnvKeys(process.env), spendCap, openSea }));
  const off = testnetsSwitchedOff(config);
  if (off.length > 0) {
    console.log(`\nTestnets are off (ENABLE_TESTNETS), so the app does not offer: ${off.map((c) => c.name).join(', ')}. Their RPC was still checked above.`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message.replace(/https?:\/\/\S+/g, '<url>') : err);
  process.exitCode = 1;
});
