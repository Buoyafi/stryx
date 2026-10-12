/**
 * The hero's "how fast is it" demo: eight wallets mint the moment a stage opens, with a clock and a
 * head-to-head against one wallet by hand.
 */

export const WALLET_NAMES = ['0x7F3A…C91', '0x2B90…44E', '0xA1D6…07B', '0x93C2…E58', '0x5D18…A3F', '0xE407…2C6', '0x61BB…9D0', '0x08F5…7E1'];
/** One wallet clicked through by hand, in demo milliseconds. Illustrative. */
export const HAND_MS = 4800;
/** The demo plays at this fraction of its nominal speed. */
export const SLOW = 0.25;
export const COUNTDOWN_MS = 1500;
const RESTART_AFTER_MS = 3800;
const FLEET_SIZE = 25;

/** Per-wallet timings: sign, send, then confirmed. `rand` returns [0, 1). */
export function planRace(rand = Math.random, wallets = WALLET_NAMES.length) {
  const between = (lo, hi) => lo + rand() * (hi - lo);
  return Array.from({ length: wallets }, () => {
    const sign = between(38, 90);
    const send = sign + between(60, 170);
    return { sign, send, done: send + between(330, 760) };
  });
}

/** The countdown before the stage opens, in half-second steps: "T−3", "T−2", "T−1". */
export function countdownLabel(msLeft) {
  return `T−${Math.max(1, Math.ceil(msLeft / 500))}`;
}

const rowState = (p, demoMs) => (demoMs >= p.done ? 'done' : demoMs < p.sign ? 'signing' : demoMs < p.send ? 'sending' : 'confirming');
const seconds = (ms, digits) => `${(ms / 1000).toFixed(digits)} s`;

/** What the demo shows `demoMs` after the stage opens, for the first `shown` wallets of the plan (phones show fewer rows). */
export function raceView(plan, demoMs, shown = plan.length) {
  const used = plan.slice(0, shown);
  const lastAll = Math.max(...used.map((p) => p.done));
  const rows = used.map((p) => {
    const state = rowState(p, demoMs);
    return {
      state,
      pct: Math.min(1, demoMs / p.done) * 100,
      text: state === 'done' ? `✓ ${Math.round(p.done)} ms` : state,
    };
  });
  const doneRows = used.filter((p) => demoMs >= p.done);
  const allDone = doneRows.length === used.length;
  const first = allDone ? Math.min(...used.map((p) => p.done)) : null;
  const handDone = demoMs >= HAND_MS;
  return {
    rows,
    allDone,
    // The clock stops at the last wallet's confirmation; the hand lane keeps going after it.
    clock: `+${Math.round(Math.min(demoMs, lastAll))} ms`,
    summary: allDone ? { confirmed: used.length, first: Math.round(first), last: Math.round(lastAll) } : null,
    stryx: { pct: Math.min(1, demoMs / lastAll) * 100, text: allDone ? `✓ ${seconds(lastAll, 2)}` : 'minting…', done: allDone },
    hand: { pct: Math.min(1, demoMs / HAND_MS) * 100, text: handDone ? `✓ ${seconds(HAND_MS, 1)}` : 'clicking…', done: handDone },
    finished: allDone && handDone,
    fleetLit: fleetLit(demoMs),
  };
}

/** How many of the 25 fleet squares are lit `demoMs` in. */
export function fleetLit(demoMs) {
  if (demoMs <= 0) return 0;
  return Math.min(FLEET_SIZE, Math.round((demoMs / 700) * FLEET_SIZE * Math.min(1, demoMs / 300 + 0.2)));
}

export function mountSpeedDemo(root, { freeze = null } = {}) {
  if (!root) return;
  const $ = (sel) => root.querySelector(sel);
  const raceEl = $('[data-race]');
  const clockEl = $('[data-clock]');
  const labelEl = $('[data-clock-label]');
  const sumEl = $('[data-race-summary]');
  const fleetEl = $('[data-fleet]');
  const handBar = $('[data-hand-bar]');
  const handText = $('[data-hand-text]');
  const stryxBar = $('[data-stryx-bar]');
  const stryxText = $('[data-stryx-text]');
  const replay = $('[data-replay]');
  if (!raceEl || !clockEl || !labelEl || !sumEl || !fleetEl) return;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const shown = () => (window.innerWidth <= 640 ? 6 : WALLET_NAMES.length);
  raceEl.innerHTML = WALLET_NAMES.map((name) => `<li><span>${name}</span><span class="track"><b></b></span><span class="st">queued</span></li>`).join('');
  const rows = [...raceEl.children].map((li) => ({ li, bar: li.querySelector('b'), st: li.querySelector('.st') }));

  // Every write to the page goes through these, which skip a write that would change nothing.
  const cache = new WeakMap();
  const setStyle = (el, prop, value) => {
    const c = cache.get(el) ?? {};
    if (c[prop] === value) return;
    c[prop] = value;
    cache.set(el, c);
    el.style[prop] = value;
  };
  const setText = (el, value) => {
    const c = cache.get(el) ?? {};
    if (c.text === value) return;
    c.text = value;
    cache.set(el, c);
    el.textContent = value;
  };
  const setClass = (el, value) => {
    const c = cache.get(el) ?? {};
    if (c.cls === value) return;
    c.cls = value;
    cache.set(el, c);
    el.className = value;
  };
  fleetEl.innerHTML = '<i></i>'.repeat(FLEET_SIZE);
  const squares = [...fleetEl.children];

  let run = null;
  let restartAt = 0;
  let onScreen = true;

  function start() {
    run = { t0: performance.now() + COUNTDOWN_MS, plan: planRace(), finished: false };
    setText(labelEl, 'STAGE OPENS IN');
    sumEl.textContent = 'Waiting for the stage to open…';
    setClass(clockEl, 'clock-val');
    rows.forEach((r) => { setStyle(r.bar, 'width', '0%'); setText(r.st, 'queued'); setClass(r.st, 'st'); setClass(r.li, ''); });
    squares.forEach((q) => q.classList.remove('on'));
    litCount = 0;
    if (handBar) {
      setStyle(handBar, 'width', '0%'); setText(handText, 'clicking…'); setClass(handText, 'st');
      setStyle(stryxBar, 'width', '0%'); setText(stryxText, 'queued'); setClass(stryxText, 'st');
    }
  }

  // Widths move in half-percent steps: finer than the eye can tell, and far fewer style changes.
  const pct = (v) => `${(Math.round(v * 2) / 2).toFixed(1)}%`;
  let litCount = 0;

  function paint(demoMs) {
    const v = raceView(run.plan, demoMs, shown());
    v.rows.forEach((row, i) => {
      setStyle(rows[i].bar, 'width', pct(row.pct));
      setText(rows[i].st, row.text);
      setClass(rows[i].st, row.state === 'done' ? 'st done' : 'st');
      setClass(rows[i].li, row.state === 'done' ? 'done' : '');
    });
    if (v.fleetLit !== litCount) {
      squares.forEach((q, i) => q.classList.toggle('on', i < v.fleetLit));
      litCount = v.fleetLit;
    }
    setText(clockEl, v.clock);
    setClass(clockEl, 'clock-val live');
    setText(labelEl, 'SINCE STAGE OPENED');
    if (stryxBar) {
      setStyle(stryxBar, 'width', pct(v.stryx.pct));
      setText(stryxText, v.stryx.text);
      setClass(stryxText, v.stryx.done ? 'st done' : 'st');
      setStyle(handBar, 'width', pct(v.hand.pct));
      setText(handText, v.hand.text);
      setClass(handText, v.hand.done ? 'st done-hand' : 'st');
    }
    if (v.summary && !run.summarised) {
      run.summarised = true;
      sumEl.innerHTML = `<span class="good">${v.summary.confirmed}/${v.summary.confirmed} confirmed</span> · first <b>${v.summary.first} ms</b> · last <b>${v.summary.last} ms</b>`;
    }
    if (v.finished && !run.finished) {
      run.finished = true;
      restartAt = performance.now() + RESTART_AFTER_MS;
    }
  }

  let lastPaint = 0;
  function tick(now) {
    requestAnimationFrame(tick);
    if (!onScreen || document.hidden) return;
    if (now - lastPaint < 30) return; // about 30 repaints a second
    lastPaint = now;
    if (!run) start();
    if (freeze) {
      // A fixed picture for screenshots and demos of the page: ?race=mid or ?race=done.
      run.plan = run.plan.map((_, i) => ({ sign: 50, send: 130 + i * 6, done: 420 + i * 70 }));
      paint(freeze === 'done' ? HAND_MS + 400 : 560);
    } else if (now < run.t0) {
      setText(clockEl, countdownLabel(run.t0 - now));
      setClass(clockEl, 'clock-val');
    } else {
      paint((now - run.t0) * SLOW);
      if (run.finished && now > restartAt) start();
    }
  }

  // Only animate while the stage is on screen.
  if (typeof IntersectionObserver !== 'undefined') {
    new IntersectionObserver((entries) => { onScreen = entries.some((e) => e.isIntersecting); }, { rootMargin: '120px' }).observe(root);
  }

  if (reduce) {
    // No motion: show the finished race once and leave it.
    start();
    run.plan = run.plan.map((_, i) => ({ sign: 50, send: 130 + i * 6, done: 420 + i * 70 }));
    paint(HAND_MS + 400);
    // Nothing would play it: a replay would only blank the finished race.
    if (replay) replay.hidden = true;
    return;
  }
  replay?.addEventListener('click', start);

  // The floating cards drift a little with the pointer.
  let drift = null;
  window.addEventListener('pointermove', (e) => {
    const first = drift === null;
    drift = e;
    if (!first) return;
    requestAnimationFrame(() => {
      if (onScreen && drift) {
        root.style.setProperty('--px', (drift.clientX / window.innerWidth - 0.5).toFixed(3));
        root.style.setProperty('--py', (drift.clientY / window.innerHeight - 0.5).toFixed(3));
      }
      drift = null;
    });
  }, { passive: true });
  requestAnimationFrame(tick);
}
