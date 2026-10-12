import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

// brand.css spins the atom about "center" of the nearest SVG viewport.
describe('landing lockup', () => {
  const html = read('../index.html');
  const header = html.slice(html.indexOf('<header class="site-header">'), html.indexOf('</header>'));
  const lockup = header.slice(header.indexOf('<svg class="stryx-logo stryx-lockup"'));

  it('wraps the atom in its own 64x64 viewport, drawn at the same place and size', () => {
    expect(lockup).toContain('<svg x="0" y="3" width="166.4" height="166.4" viewBox="0 0 64 64" overflow="visible"><g class="stryx-orbits">');
    expect(lockup).not.toContain('translate(0 3) scale(2.6)');
    // Balanced: two <svg> opened (lockup + atom), two closed, before the link ends.
    const inLink = lockup.slice(0, lockup.indexOf('</a>'));
    expect(inLink.match(/<svg[\s>]/g)?.length).toBe(2);
    expect(inLink.match(/<\/svg>/g)?.length).toBe(2);
  });

  it('is otherwise the brand asset, unchanged (atom and wordmark paths)', () => {
    const asset = read('../../../brand/stryx-lockup.svg');
    const between = (s, a, b) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));
    const atom = (s) => between(s, '<g class="stryx-orbits">', '<g transform="translate(180 120.5)');
    expect(atom(lockup).replace(/<\/svg>$/, '')).toBe(atom(asset).replace(/<\/g>$/, ''));
    const word = (s) => between(s, '<g transform="translate(180 120.5)', '</svg>');
    expect(word(lockup)).toBe(word(asset));
  });

  it('brand.css no longer carries a lockup-only pivot', () => {
    expect(read('../../../brand/brand.css')).not.toMatch(/\.stryx-lockup \.stryx-orbits/);
  });
});
