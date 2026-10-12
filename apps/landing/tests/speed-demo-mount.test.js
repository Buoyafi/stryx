// @vitest-environment jsdom
/* global document */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountSpeedDemo } from '../src/lib/speed-demo.js';

const markup = `
  <ol data-race></ol><span data-clock></span><span data-clock-label></span>
  <span data-race-summary></span><div data-fleet></div>
  <button data-replay type="button">Replay</button>`;

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('mountSpeedDemo', () => {
  it('under reduced motion shows the finished race and hides Replay, which would only blank it', () => {
    vi.stubGlobal('matchMedia', (q) => ({ matches: q.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal('requestAnimationFrame', () => 0);
    const root = document.createElement('section');
    root.innerHTML = markup;
    document.body.appendChild(root);

    mountSpeedDemo(root);

    expect(root.querySelector('[data-replay]').hidden).toBe(true);
    expect(root.querySelector('[data-race-summary]').textContent).toMatch(/confirmed/);
  });
});
