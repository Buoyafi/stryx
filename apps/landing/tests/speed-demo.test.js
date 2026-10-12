import { describe, expect, it } from 'vitest';
import { COUNTDOWN_MS, HAND_MS, WALLET_NAMES, countdownLabel, fleetLit, planRace, raceView } from '../src/lib/speed-demo.js';

// A fixed plan: wallet i signs at 50, sends at 130 + 6i, confirms at 420 + 70i.
const plan = WALLET_NAMES.map((_, i) => ({ sign: 50, send: 130 + i * 6, done: 420 + i * 70 }));

describe('planRace', () => {
  it('plans every wallet with sign < send < done', () => {
    const p = planRace();
    expect(p).toHaveLength(WALLET_NAMES.length);
    for (const w of p) {
      expect(w.sign).toBeGreaterThan(0);
      expect(w.send).toBeGreaterThan(w.sign);
      expect(w.done).toBeGreaterThan(w.send);
    }
  });

  it('keeps the whole race well under the by-hand time, however the dice fall', () => {
    for (const rand of [() => 0, () => 0.999, Math.random]) {
      expect(Math.max(...planRace(rand).map((w) => w.done))).toBeLessThan(HAND_MS / 2);
    }
  });

  it('is repeatable for a given random source', () => {
    const seq = () => { let n = 0; return () => ((n += 0.137) % 1); };
    expect(planRace(seq())).toEqual(planRace(seq()));
  });
});

describe('raceView', () => {
  it('walks each wallet through signing, sending and confirming, then done with its time', () => {
    expect(raceView(plan, 20).rows[0].text).toBe('signing');
    expect(raceView(plan, 100).rows[0].text).toBe('sending');
    expect(raceView(plan, 300).rows[0].text).toBe('confirming');
    expect(raceView(plan, 420).rows[0]).toMatchObject({ text: '✓ 420 ms', state: 'done', pct: 100 });
  });

  it('shows progress as a share of each wallet\'s own time, never past 100', () => {
    const v = raceView(plan, 210);
    expect(v.rows[0].pct).toBeCloseTo(50, 5);
    expect(raceView(plan, 99999).rows.every((r) => r.pct === 100)).toBe(true);
  });

  it('only has a summary once every shown wallet has confirmed', () => {
    expect(raceView(plan, 800).summary).toBeNull();
    expect(raceView(plan, 910)).toMatchObject({ allDone: true, summary: { confirmed: 8, first: 420, last: 910 } });
  });

  it('counts only the wallets that are shown (phones show fewer rows)', () => {
    const v = raceView(plan, 770, 6);
    expect(v.rows).toHaveLength(6);
    expect(v.summary).toEqual({ confirmed: 6, first: 420, last: 770 });
  });

  it('stops the clock at the last confirmation while the by-hand lane keeps going', () => {
    expect(raceView(plan, 300).clock).toBe('+300 ms');
    const after = raceView(plan, 3000);
    expect(after.clock).toBe('+910 ms');
    expect(after.stryx).toMatchObject({ text: '✓ 0.91 s', done: true });
    expect(after.hand).toMatchObject({ text: 'clicking…', done: false });
    expect(after.finished).toBe(false);
  });

  it('finishes when the by-hand wallet does, at 4.8 s', () => {
    const end = raceView(plan, HAND_MS);
    expect(end.hand).toMatchObject({ text: '✓ 4.8 s', pct: 100, done: true });
    expect(end.finished).toBe(true);
  });

  it('never shows a lane past full', () => {
    const v = raceView(plan, HAND_MS * 3);
    expect(v.hand.pct).toBe(100);
    expect(v.stryx.pct).toBe(100);
  });
});

describe('fleetLit', () => {
  it('starts dark, fills up as the run goes, and never exceeds the 25 wallets', () => {
    expect(fleetLit(0)).toBe(0);
    expect(fleetLit(100)).toBeGreaterThan(0);
    expect(fleetLit(400)).toBeGreaterThan(fleetLit(100));
    expect(fleetLit(99999)).toBe(25);
  });
});

describe('countdownLabel', () => {
  it('counts T−3, T−2, T−1 over the lead-in and never reads zero', () => {
    expect(countdownLabel(COUNTDOWN_MS)).toBe('T−3');
    expect(countdownLabel(900)).toBe('T−2');
    expect(countdownLabel(400)).toBe('T−1');
    expect(countdownLabel(1)).toBe('T−1');
  });
});
