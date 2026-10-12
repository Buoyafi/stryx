import { describe, expect, it } from 'vitest';
import { keccak256 } from 'viem';
import { chainById } from '../src/chain-registry.js';
import { checkOpenSea, diagnoseChain, formatDoctorReport, type Check, type DoctorClient } from '../src/chain-doctor.js';

const NOW = 1_800_000_000_000;
const ETH = chainById(1)!;
const RH = chainById(4663)!;
const CODE = '0x6080604052' as const;

function fake(over: Partial<DoctorClient> & { chainId?: number; disperseCode?: `0x${string}` } = {}): DoctorClient {
  return {
    getChainId: async () => over.chainId ?? 1,
    getBlock: async () => ({ number: 100n, timestamp: BigInt(NOW / 1000 - 12) }),
    estimateFeesPerGas: async () => ({ maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }),
    getCode: async ({ address }) => (address.toLowerCase() === ETH.disperseContract!.address.toLowerCase() ? (over.disperseCode ?? CODE) : '0x1234'),
    call: async () => ({ data: '0x' }),
    getBalance: async () => 1_500_000_000_000_000_000n,
    ...over,
  };
}

// The registry pins the real on-chain hash; point a copy of Ethereum at our fake code's hash.
const ethWithFakeHash = { ...ETH, disperseContract: { ...ETH.disperseContract!, codeHash: keccak256(CODE) } };
const ep = (client: DoctorClient, slot: 'main' | 'fallback' = 'main') => ({ slot, envKey: slot === 'main' ? 'RPC_ETHEREUM' : 'RPC_ETHEREUM_FALLBACK', host: 'eth.example.com', client });
const byName = (checks: readonly Check[], name: string): Check => checks.find((c) => c.name === name)!;

describe('chain doctor', () => {
  it('a healthy chain: every check passes, balance read in the chain symbol', async () => {
    const r = await diagnoseChain(ethWithFakeHash, [ep(fake()), ep(fake(), 'fallback')], { address: '0x1111111111111111111111111111111111111111', now: () => NOW });
    expect(r.endpoints.flatMap((e) => e.checks).every((c) => c.status === 'ok')).toBe(true);
    expect(r.checks.map((c) => [c.name, c.status])).toEqual([
      ['fees', 'ok'],
      ['balance', 'ok'],
      ['plain transfer', 'ok'],
      ['disperse contract', 'ok'],
      ['SeaDrop', 'ok'],
    ]);
    expect(byName(r.checks, 'balance').detail).toMatch(/^1\.5 ETH/);
    expect(byName(r.checks, 'fees').detail).toMatch(/tip setting shown/);
  });

  it('a URL for the wrong chain is a failure naming the env var', async () => {
    const r = await diagnoseChain(ETH, [ep(fake({ chainId: 8453 }))], { now: () => NOW });
    expect(byName(r.endpoints[0]!.checks, 'chain id')).toMatchObject({ status: 'fail' });
    expect(byName(r.endpoints[0]!.checks, 'chain id').detail).toMatch(/chain 8453.*RPC_ETHEREUM/);
    expect(byName(r.checks, 'chain')).toMatchObject({ status: 'fail' });
  });

  it('a dead main endpoint with a working fallback still diagnoses the chain through the fallback', async () => {
    const dead = fake({ getChainId: async () => { throw new Error('fetch failed https://eth.example.com/v2/KEY'); } });
    const r = await diagnoseChain(ethWithFakeHash, [ep(dead), ep(fake(), 'fallback')], { now: () => NOW });
    expect(byName(r.endpoints[0]!.checks, 'chain id').status).toBe('fail');
    expect(byName(r.endpoints[0]!.checks, 'chain id').detail).not.toContain('KEY');
    expect(byName(r.checks, 'plain transfer').status).toBe('ok');
  });

  it('disperse: a code-hash mismatch fails, a provider without state override is a skip, not a failure', async () => {
    const mismatch = await diagnoseChain(ethWithFakeHash, [ep(fake({ disperseCode: '0x60806040ff' }))], { now: () => NOW });
    expect(byName(mismatch.checks, 'disperse contract').status).toBe('fail');

    const noOverride = fake({ call: async () => { throw new Error('invalid params: state override not supported'); } });
    const r = await diagnoseChain(ethWithFakeHash, [ep(noOverride)], { now: () => NOW });
    expect(byName(r.checks, 'plain transfer').status).toBe('skip');
    expect(byName(r.checks, 'disperse contract').status).toBe('ok');
  });

  it('a chain without SeaDrop warns that minting is not supported there', async () => {
    const r = await diagnoseChain(ethWithFakeHash, [ep(fake({ getCode: async () => '0x' }))], { now: () => NOW });
    expect(byName(r.checks, 'SeaDrop').status).toBe('warn');
  });

  it('Robinhood: no fallback warns, no disperse contract is a skip, first come first served', async () => {
    const r = await diagnoseChain(RH, [{ ...ep(fake({ chainId: 4663 })), envKey: 'RPC_ROBINHOOD_PRIMARY' }], { now: () => NOW });
    expect(byName(r.checks, 'fallback').status).toBe('warn');
    expect(byName(r.checks, 'disperse contract').status).toBe('skip');
    expect(byName(r.checks, 'fees').detail).toMatch(/first come first served/);
  });

  it('report: unconfigured chains listed, misnamed env vars fail with the fix', async () => {
    const unconfigured = await diagnoseChain(chainById(10)!, []);
    const text = formatDoctorReport([unconfigured], { misnamed: [{ key: 'RPC_ETHEREUM_PRIMARY', didYouMean: 'RPC_ETHEREUM' }] });
    expect(text).toContain('Optimism (10): not configured');
    expect(text).toContain('RPC_ETHEREUM_PRIMARY is set but no chain reads it: rename it to RPC_ETHEREUM');
    expect(text).toContain('1 failure(s) above.');
  });
});

describe('chain doctor: phase B checks', () => {
  const BNB = chainById(56)!;
  const bnbClient = (disperseCode: `0x${string}`) =>
    fake({ chainId: 56, getCode: async ({ address }) => (address.toLowerCase() === '0xd152f549545093347a162dce210e7293f1452150' ? disperseCode : '0x6080') });

  it('no Disperse pinned (Avalanche): reports code at the usual address and whether it is a known build', async () => {
    const AVAX = chainById(43114)!;
    const avaxClient = (code: `0x${string}`) => fake({ chainId: 43114, getCode: async ({ address }) => (address.toLowerCase() === '0xd152f549545093347a162dce210e7293f1452150' ? code : '0x6080') });
    const unknown = await diagnoseChain(AVAX, [{ ...ep(avaxClient('0x60806040aa')), envKey: 'RPC_AVALANCHE' }], { now: () => NOW });
    expect(byName(unknown.checks, 'disperse contract').detail).toMatch(/NOT a known Disperse build/);

    const none = await diagnoseChain(AVAX, [{ ...ep(avaxClient('0x')), envKey: 'RPC_AVALANCHE' }], { now: () => NOW });
    expect(byName(none.checks, 'disperse contract').detail).toMatch(/none on this chain/);
  });

  it('prices: shown with the chain symbol, a missing one warns, Robinhood skips by design', async () => {
    const withPrice = await diagnoseChain(BNB, [{ ...ep(bnbClient('0x')), envKey: 'RPC_BNB' }], { now: () => NOW, price: async () => ({ ok: true as const, usd: 612.5 }) });
    expect(byName(withPrice.checks, 'price')).toMatchObject({ status: 'ok', detail: '$612.5 per BNB (USD toggle and cost estimates)' });

    const limited = await diagnoseChain(BNB, [{ ...ep(bnbClient('0x')), envKey: 'RPC_BNB' }], { now: () => NOW, price: async () => ({ ok: false as const, reason: 'rate-limited (HTTP 429)' }) });
    expect(byName(limited.checks, 'price')).toMatchObject({ status: 'warn' });
    expect(byName(limited.checks, 'price').detail).toContain('rate-limited (HTTP 429)');

    const rh = await diagnoseChain(RH, [{ ...ep(fake({ chainId: 4663 })), envKey: 'RPC_ROBINHOOD_PRIMARY' }], { now: () => NOW, price: async () => null });
    expect(byName(rh.checks, 'price').status).toBe('skip');
  });
});

describe('chain doctor: OpenSea reachability', () => {
  const answer = (status: number) => async () => ({ ok: status < 300, status });
  it('3 of 3 answered: OK with each time', async () => {
    let t = 0;
    const r = await checkOpenSea(answer(200), 'key', () => (t += 100));
    expect(r[0]).toMatchObject({ status: 'ok', detail: '3 of 3 requests answered (100 ms; 100 ms; 100 ms)' });
  });

  it('an intermittent failure is a warning that names the real cause', async () => {
    let n = 0;
    const flaky = async () => {
      if (n++ === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ETIMEDOUT 104.18.1.1:443'), { code: 'ETIMEDOUT' }) });
      return { ok: true, status: 200 };
    };
    const r = await checkOpenSea(flaky, 'key');
    expect(r[0]!.status).toBe('warn');
    expect(r[0]!.detail).toMatch(/2 of 3 requests answered .*the connection timed out/);
  });

  it('a refused key fails, a missing key warns', async () => {
    expect((await checkOpenSea(answer(401), 'bad'))[0]!.status).toBe('fail');
    expect((await checkOpenSea(answer(200), undefined))[0]).toMatchObject({ status: 'warn', detail: expect.stringMatching(/OPENSEA_API_KEY is not set/) });
  });
});
