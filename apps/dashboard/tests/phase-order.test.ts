import { describe, expect, it } from 'vitest';
import { sortPhasesChronologically } from '../src/lib/phase-order';
import type { Phase } from '../src/lib/collection-phases';

const NOW = 1_800_000_000_000;

function phase(overrides: Partial<Phase> & Pick<Phase, 'id'>): Phase {
  return {
    name: overrides.id,
    kind: 'allowlist',
    priceWei: '0',
    startMs: null,
    endMs: null,
    maxPerWallet: null,
    source: 'opensea',
    mechanism: 'merkle',
    openSeaStageUuid: null,
    ...overrides,
  };
}

describe('sortPhasesChronologically', () => {
  it('orders strictly by start time, even when the source data has public first (it rendered first regardless of when it actually starts)', () => {
    const publicPhase = phase({ id: 'public', kind: 'public', mechanism: null, startMs: NOW + 20_000, endMs: NOW + 30_000 });
    const gtd = phase({ id: 'gtd', name: 'GTD', startMs: NOW, endMs: NOW + 10_000 });
    const fcfs = phase({ id: 'fcfs', name: 'FCFS', startMs: NOW + 10_000, endMs: NOW + 20_000 });

    // Deliberately out of order, public first, matching the real API's current (buggy) order.
    const result = sortPhasesChronologically([publicPhase, gtd, fcfs]);

    expect(result.map((p) => p.id)).toEqual(['gtd', 'fcfs', 'public']);
  });

  it('never sorts by kind: an allow-list phase starting later still comes after a public phase starting earlier', () => {
    const earlyPublic = phase({ id: 'public', kind: 'public', mechanism: null, startMs: NOW, endMs: NOW + 10_000 });
    const laterAllowlist = phase({ id: 'late-list', startMs: NOW + 5_000, endMs: NOW + 15_000 });

    expect(sortPhasesChronologically([laterAllowlist, earlyPublic]).map((p) => p.id)).toEqual(['public', 'late-list']);
  });

  it('never sorts by name: alphabetically-first names do not win over a later start time', () => {
    const aardvark = phase({ id: 'a', name: 'Aardvark list', startMs: NOW + 10_000 });
    const zebra = phase({ id: 'z', name: 'Zebra list', startMs: NOW });

    expect(sortPhasesChronologically([aardvark, zebra]).map((p) => p.id)).toEqual(['z', 'a']);
  });

  it('an ended phase keeps its chronological place: it is not moved to the end just because it is over', () => {
    const endedEarly = phase({ id: 'ended-early', startMs: NOW - 20_000, endMs: NOW - 10_000 });
    const liveMiddle = phase({ id: 'live-middle', startMs: NOW - 5_000, endMs: NOW + 5_000 });
    const upcomingLate = phase({ id: 'upcoming-late', startMs: NOW + 10_000, endMs: NOW + 20_000 });

    // Source order deliberately scrambled.
    const result = sortPhasesChronologically([upcomingLate, endedEarly, liveMiddle]);
    expect(result.map((p) => p.id)).toEqual(['ended-early', 'live-middle', 'upcoming-late']);
  });

  it('ties on start time break on end time', () => {
    const shorter = phase({ id: 'shorter', startMs: NOW, endMs: NOW + 1_000 });
    const longer = phase({ id: 'longer', startMs: NOW, endMs: NOW + 2_000 });

    expect(sortPhasesChronologically([longer, shorter]).map((p) => p.id)).toEqual(['shorter', 'longer']);
  });

  it('ties on both start and end time break on the original (OpenSea) source order', () => {
    const first = phase({ id: 'first', startMs: NOW, endMs: NOW + 1_000 });
    const second = phase({ id: 'second', startMs: NOW, endMs: NOW + 1_000 });

    expect(sortPhasesChronologically([second, first]).map((p) => p.id)).toEqual(['second', 'first']); // source order preserved, not re-sorted by id
  });

  it('a phase with no known start time falls back to source order, sorting after every phase that DOES have a start time', () => {
    const unknownFirst = phase({ id: 'unknown-first', startMs: null });
    const known = phase({ id: 'known', startMs: NOW });
    const unknownSecond = phase({ id: 'unknown-second', startMs: null });

    const result = sortPhasesChronologically([unknownFirst, known, unknownSecond]);
    expect(result.map((p) => p.id)).toEqual(['known', 'unknown-first', 'unknown-second']);
  });

  it('does not mutate the input array', () => {
    const input = [phase({ id: 'b', startMs: NOW + 1 }), phase({ id: 'a', startMs: NOW })];
    const copy = [...input];
    sortPhasesChronologically(input);
    expect(input).toEqual(copy);
  });
});
