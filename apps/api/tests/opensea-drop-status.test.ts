import { describe, expect, it } from 'vitest';
import { fetchOpenSeaDropInfoResult } from '../src/opensea-drop-info.js';
import { OpenSeaDropInfoCache } from '../src/opensea-drop-info-cache.js';
import type { FetchLike } from '../src/opensea-resolver.js';
import type { DropInfoResult, OpenSeaDropInfo } from '../src/opensea-drop-info.js';

const CONTRACT = '0xc62caba0cf5774d8e40e2651e86a0014de8ab768';
const DROP = {
  collection_name: 'Kid Story',
  stages: [
    { uuid: 'gtd', stage_type: 'signed_presale', label: 'GTD', start_time: '2026-09-28T14:00:00Z' },
    { uuid: 'fcfs', stage_type: 'signed_presale', label: 'FCFS', start_time: '2026-09-28T16:00:00Z' },
  ],
};

/** Answers the two OpenSea calls from a script: `contract` then `drop`, each a status or a thrown transport failure. */
function scripted(contract: Array<number | 'fail'>, drop: Array<number | 'fail'> = [200]) {
  const calls: string[] = [];
  const next = (queue: Array<number | 'fail'>) => (queue.length > 1 ? queue.shift()! : queue[0]!);
  const fetchImpl: FetchLike = async (url) => {
    const isContract = url.includes('/contract/');
    calls.push(isContract ? 'contract' : 'drop');
    const step = next(isContract ? contract : drop);
    if (step === 'fail') throw new TypeError('fetch failed');
    return { ok: step >= 200 && step < 300, status: step, json: async () => (isContract ? { collection: 'kid-story' } : DROP) };
  };
  return { fetchImpl, calls };
}

describe('fetchOpenSeaDropInfoResult: "not listed" and "unreachable" are different answers', () => {
  it('ok: returns the stages', async () => {
    const r = await fetchOpenSeaDropInfoResult(scripted([200]).fetchImpl, 'key', 'robinhood', CONTRACT);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.info.stages.map((s) => s.label)).toEqual(['GTD', 'FCFS']);
  });

  it('retries a transport failure (3 attempts in all) and succeeds', async () => {
    const s = scripted(['fail', 'fail', 200]);
    const r = await fetchOpenSeaDropInfoResult(s.fetchImpl, 'key', 'robinhood', CONTRACT);
    expect(r.status).toBe('ok');
    expect(s.calls.filter((c) => c === 'contract')).toHaveLength(3);
  });

  it.each([
    ['transport failure every time', ['fail'] as Array<number | 'fail'>, [200] as Array<number | 'fail'>],
    ['a 5xx on the contract lookup', [503], [200]],
    ['a 429 on the drop lookup', [200], [429]],
  ])('unavailable, not "not listed": %s', async (_label, contract, drop) => {
    const r = await fetchOpenSeaDropInfoResult(scripted(contract, drop).fetchImpl, 'key', 'robinhood', CONTRACT);
    expect(r.status).toBe('unavailable');
  });

  it('not listed: a 404 from OpenSea, or no API key at all', async () => {
    expect((await fetchOpenSeaDropInfoResult(scripted([404]).fetchImpl, 'key', 'robinhood', CONTRACT)).status).toBe('not_listed');
    expect((await fetchOpenSeaDropInfoResult(scripted([200], [404]).fetchImpl, 'key', 'robinhood', CONTRACT)).status).toBe('not_listed');
    expect((await fetchOpenSeaDropInfoResult(scripted([200]).fetchImpl, undefined, 'robinhood', CONTRACT)).status).toBe('not_listed');
  });
});

describe('OpenSeaDropInfoCache', () => {
  const info = { collectionName: 'Kid Story', stages: [{ label: 'GTD' }] } as unknown as OpenSeaDropInfo;

  it('an OpenSea blip serves the last good stages, marked stale, instead of dropping them', async () => {
    let now = 1_000_000;
    let next: DropInfoResult = { status: 'ok', info };
    const cache = new OpenSeaDropInfoCache(async () => next, () => now);

    expect(await cache.get(4663, CONTRACT)).toEqual({ info, openSea: 'ok' });
    next = { status: 'unavailable', detail: 'could not reach OpenSea' };
    now += 60_000;
    expect(await cache.get(4663, CONTRACT.toUpperCase().replace('0X', '0x'))).toEqual({ info, openSea: 'stale', asOf: 1_000_000 });
  });

  it('nothing remembered (or too old): says unavailable, with no info', async () => {
    let now = 0;
    let next: DropInfoResult = { status: 'unavailable', detail: 'x' };
    const cache = new OpenSeaDropInfoCache(async () => next, () => now, 1_000);
    expect(await cache.get(4663, CONTRACT)).toEqual({ info: null, openSea: 'unavailable' });

    next = { status: 'ok', info };
    await cache.get(4663, CONTRACT);
    next = { status: 'unavailable', detail: 'x' };
    now = 5_000;
    expect(await cache.get(4663, CONTRACT)).toEqual({ info: null, openSea: 'unavailable' });
  });

  it('a real "not listed" answer is passed straight through, never replaced by the remembered stages', async () => {
    let next: DropInfoResult = { status: 'ok', info };
    const cache = new OpenSeaDropInfoCache(async () => next);
    await cache.get(4663, CONTRACT);
    next = { status: 'not_listed' };
    expect(await cache.get(4663, CONTRACT)).toEqual({ info: null, openSea: 'not_listed' });
  });
});
