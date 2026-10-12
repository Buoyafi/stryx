/**
 * The landing page's background: one fixed canvas of drifting physics equations and numbers, with soft
 * ripples across the top of the hero only.
 */

const EQUATIONS = [
  'iħ ∂ψ/∂t = Ĥψ', '|ψ⟩ = α|0⟩ + β|1⟩', '⟨φ|ψ⟩', 'Ĥ|n⟩ = Eₙ|n⟩', '[x̂, p̂] = iħ', 'ΔxΔp ≥ ħ/2', 'E = hν',
  'ψ(x) = A e^{ikx}', '∇²ψ + (2m/ħ²)(E−V)ψ = 0', 'ρ = Σ pᵢ |ψᵢ⟩⟨ψᵢ|', 'U = e^{−iĤt/ħ}', '|Φ⁺⟩ = (|00⟩ + |11⟩)/√2',
  'S = −k Tr(ρ ln ρ)', 'H = (1/√2)[[1, 1],[1, −1]]', 'σₓ = [[0,1],[1,0]]', 'ħ = 1.0546×10⁻³⁴ J·s', 'h = 6.626×10⁻³⁴',
  '0.70710678', '1.61803398', '299 792 458', '∮ B·dl = μ₀I', 'P = |⟨x|ψ⟩|²', 'Δ = b² − 4ac', 'Tr(ρ²) ≤ 1', '|0⟩', '|1⟩',
  '|+⟩', '|−⟩', '⟨0|', 'CNOT', 'Ŝ = ½ħσ', 'λ = h/p', 'keccak256(0x…)', '0x7F3A…C91', '0x2B90…44E', '01101001',
  '10010110', 'nonce 0x4f', 'Σ|cᵢ|² = 1',
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 1 = full strength, down to 0.28 right behind the hero text. */
export function calmFactor(x, y, { width, height, scrollY = 0 }) {
  const cx = width / 2;
  const cy = Math.min(height * 0.46, 430) - scrollY;
  const rx = Math.min(width * 0.38, 560);
  const ry = 250;
  const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
  const u = clamp((d - 0.5) / 0.7, 0, 1);
  return 0.28 + 0.72 * u * u * (3 - 2 * u);
}

/** How many floating items to draw: scales with the screen, capped so a big monitor stays cheap. */
export function itemCountFor(width, height) {
  return Math.round(clamp((width * height) / 12500, 46, 150));
}

/** '#RRGGBB' to [r, g, b], or null for anything else (the tokens are plain hex values). */
export function parseHex(value) {
  const m = /^#([0-9a-f]{6})$/i.exec((value || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mountBackground(canvas) {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.documentElement;
  const pointer = { x: -9999, y: -9999, tx: -9999, ty: -9999 };
  const tok = { accent: [204, 255, 0], ink: [244, 246, 236], glow: [143, 133, 230] };
  let W = 0;
  let H = 0;
  let scrollY = 0;
  let last = performance.now();
  const t0 = last;
  const coarse = window.matchMedia('(pointer: coarse)').matches;

  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const calm = (x, y) => calmFactor(x, y, { width: W, height: H, scrollY });
  const lightK = () => (root.dataset.theme === 'light' ? 0.62 : 1);

  function readTokens() {
    const cs = getComputedStyle(root);
    for (const [key, name] of [['accent', '--stryx-accent'], ['ink', '--stryx-ink'], ['glow', '--stryx-glow']]) {
      const c = parseHex(cs.getPropertyValue(name));
      if (c) tok[key] = c;
    }
  }

  // Three depth layers, each with one font size: the font is set once per group, not once per item.
  const FONT_SIZES = [12, 15, 20];
  const fontFor = (size) => `${size}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  let layers = [];

  function seed() {
    const n = Math.round(itemCountFor(W, H) * (coarse ? 0.7 : 1));
    layers = FONT_SIZES.map(() => []);
    for (let i = 0; i < n; i++) {
      const layer = i % 3; // far, mid, near
      layers[layer].push({
        s: EQUATIONS[(Math.random() * EQUATIONS.length) | 0],
        x: Math.random() * W,
        y: Math.random() * H,
        vy: -[3, 7, 13][layer] * (0.6 + Math.random() * 0.8),
        vx: (Math.random() - 0.5) * [2, 4, 8][layer],
        a: [0.16, 0.26, 0.4][layer],
        ph: Math.random() * 6.28,
      });
    }
  }

  function resize() {
    // On phones the address bar sliding away changes the height by a few dozen pixels without any real
    // resize.
    if (W && window.innerWidth === W && Math.abs(window.innerHeight - H) < 160) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
    waveAt = -1;
    if (reduce) draw(0, 0);
  }

  // The ripples change slowly, so they are painted into a small off-screen canvas about 8 times a
  // second and copied each frame.
  const wave = document.createElement('canvas');
  const wctx = wave.getContext('2d');
  const WAVE_SCALE = 0.5;
  let waveAt = -1;

  function bakeWaves(t) {
    const reach = Math.ceil(H * 0.68);
    const w = Math.ceil(W * WAVE_SCALE);
    const h = Math.ceil(reach * WAVE_SCALE);
    if (wave.width !== w || wave.height !== h) {
      wave.width = w;
      wave.height = h;
    }
    wctx.setTransform(WAVE_SCALE, 0, 0, WAVE_SCALE, 0, 0);
    wctx.clearRect(0, 0, W, reach);
    const gap = W < 700 ? 20 : 24;
    const k = 0.05;
    const speed = 1.4;
    const s1 = { x: W * 0.32, y: -30 };
    const s2 = { x: W * 0.68, y: -30 };
    for (let y = gap / 2; y < reach; y += gap) {
      const m = Math.pow(1 - y / reach, 1.6);
      for (let x = gap / 2; x < W; x += gap) {
        const e = (Math.sin(k * Math.hypot(x - s1.x, y - s1.y) - speed * t) + Math.sin(k * Math.hypot(x - s2.x, y - s2.y) - speed * t) + 2) / 4;
        if (e < 0.58) continue;
        wctx.fillStyle = rgba(tok.glow, ((e - 0.58) / 0.42) * 0.55 * m * calm(x, y) * lightK());
        wctx.beginPath();
        wctx.arc(x, y, 0.8 + e * e * 2.2, 0, 6.2832);
        wctx.fill();
      }
    }
    waveAt = t;
  }

  /** Two sources just above the page send ripples down the hero; they fade out as you scroll. */
  function drawWaves(t) {
    const fade = Math.max(0, 1 - scrollY / (H * 0.7));
    if (fade < 0.03) return;
    if (waveAt < 0 || t - waveAt > 0.12) bakeWaves(t);
    ctx.globalAlpha = fade;
    ctx.drawImage(wave, 0, 0, W, wave.height / WAVE_SCALE);
    ctx.globalAlpha = 1;
  }

  function drawEquations(dt, t) {
    ctx.textBaseline = 'middle';
    layers.forEach((items, layer) => {
      ctx.font = fontFor(FONT_SIZES[layer]);
      for (const it of items) {
        it.y += it.vy * dt;
        it.x += it.vx * dt;
        if (it.y < -30) {
          it.y = H + 30;
          it.x = Math.random() * W;
        }
        if (it.x < -300) it.x = W + 20;
        if (it.x > W + 300) it.x = -20;
        const dx = it.x - pointer.x;
        const dy = it.y - pointer.y;
        const c = calm(it.x, it.y);
        const near = Math.max(0, 1 - Math.hypot(dx, dy) / 240) * c;
        const flick = (0.82 + 0.18 * Math.sin(t * 0.9 + it.ph)) * c * lightK();
        ctx.fillStyle = near > 0.02 ? rgba(tok.accent, Math.min(1, it.a * flick + near * 0.75)) : rgba(tok.ink, it.a * flick * 0.55);
        ctx.fillText(it.s, it.x - dx * near * 0.04, it.y - dy * near * 0.04);
      }
    });
  }

  function draw(dt, t) {
    ctx.clearRect(0, 0, W, H);
    drawWaves(t);
    drawEquations(dt, t);
  }

  // The background is soft decoration: 30 frames a second is plenty, and 15 once the hero is far
  // behind.
  let lastDraw = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const gap = scrollY > H * 1.5 ? 1000 / 15 : 1000 / 30;
    if (now - lastDraw < gap - 2) return;
    lastDraw = now;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const k = Math.min(1, dt * 9);
    pointer.x += (pointer.tx - pointer.x) * k;
    pointer.y += (pointer.ty - pointer.y) * k;
    draw(dt, (now - t0) / 1000);
  }

  window.addEventListener('pointermove', (e) => {
    pointer.tx = e.clientX;
    pointer.ty = e.clientY;
    if (pointer.x < -999) {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
    }
  }, { passive: true });
  document.addEventListener('pointerleave', () => { pointer.tx = pointer.ty = -9999; });
  window.addEventListener('resize', resize);
  // Past the hero the background steps back so the cards read cleanly.
  let scrollQueued = false;
  let lastOpacity = '';
  window.addEventListener('scroll', () => {
    scrollY = window.scrollY;
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      const opacity = String(Math.max(0.35, 1 - scrollY / (H * 0.9)).toFixed(2));
      if (opacity !== lastOpacity) {
        lastOpacity = opacity;
        canvas.style.opacity = opacity;
      }
      if (reduce) draw(0, 0);
    });
  }, { passive: true });
  // A theme switch changes the colours: read them again.
  new MutationObserver(() => { readTokens(); waveAt = -1; if (reduce) draw(0, 0); }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

  readTokens();
  resize();
  if (!reduce) requestAnimationFrame(frame);
}
