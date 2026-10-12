import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** brand/BRAND.md: never hardcode a hex value in a component. These tests keep that true. */
const root = join(import.meta.dirname, '..');
const chainUi = join(root, '..', '..', 'packages', 'chain-ui', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path);
    return /\.(css|tsx?)$/.test(name) ? [path] : [];
  });
}

const files = [...walk(join(root, 'src')), ...walk(chainUi)];
const HARDCODED = /(?<![&\w-])#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\blab\(/;

describe('no hardcoded colours in the dashboard or the shared chain UI', () => {
  it('scans a meaningful set of files', () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((f) => f.endsWith('styles.css'))).toBe(true);
    expect(files.some((f) => f.endsWith('BottomBar.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('chain-ui.css'))).toBe(true);
  });

  it('finds no hex, rgb(), hsl(), oklch() or lab() anywhere', () => {
    const offenders = files.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ f, i: i + 1, line }))
        .filter(({ line }) => HARDCODED.test(line.replace(/&#\d+;/g, '')))
        .map(({ f: file, i, line }) => `${file.replace(root, '')}:${i}: ${line.trim().slice(0, 100)}`),
    );
    expect(offenders).toEqual([]);
  });

  it('the pattern itself catches what it should (so a pass means something)', () => {
    for (const bad of ['color: #CCFF00;', 'fill: #fff', 'background: rgb(0, 0, 0)', 'x: rgba(1,2,3,.4)', 'hsl(10 20% 30%)', 'color: #12345678']) expect(HARDCODED.test(bad), bad).toBe(true);
    for (const ok of ['color: var(--stryx-accent)', 'fill="url(#hatch-abc)"', '&#10003;', 'color-mix(in srgb, var(--stryx-ink) 6%, transparent)', 'const a = b#c']) expect(HARDCODED.test(ok.replace(/&#\d+;/g, '')), ok).toBe(false);
  });
});

/** The body of a CSS rule, by selector. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1]!;
}

describe('the status pill and segmented control styling use exactly the specified tokens', () => {
  const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8');

  it('hovering the SELECTED segment keeps its accent fill (a hover rule that beat it once left white text on pale grey)', () => {
    expect(css).toMatch(/\.segmented__option:hover:not\(:disabled\):not\(\.is-selected\)\s*\{/);
    expect(css).not.toMatch(/\.segmented__option:hover:not\(:disabled\)\s*\{/);
  });

  it('a failed status is the --stryx-fail pill (with its cross glyph)', () => {
    expect(rule(css, '.pill.fail')).toMatch(/--pill-c:\s*var\(--stryx-fail\)/);
    expect(rule(css, '.pill.fail::before')).toMatch(/content:\s*'✕'/);
  });
});

describe('touch screens: no blue flash, no stuck hover, dialogs that fit', () => {
  const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8');

  it('turns off the browser\'s own tap highlight (a translucent blue box on Android)', () => {
    expect(css).toMatch(/\*\s*\{\s*-webkit-tap-highlight-color:\s*transparent;\s*\}/);
  });

  it('only styles :hover where a real hover exists, so a tap does not leave the accent border stuck on', () => {
    const allowed = [/stryx-icon-/, /generate-wallet-btn:hover/, /\.marquee__view:/, /\.home-table tbody tr:hover/, /wallets-table tr\.wl-row:hover/];
    const offenders = css
      .split('\n')
      .map((line, i) => ({ line, i: i + 1 }))
      .filter(({ line }) => line.includes(':hover') && !line.trimStart().startsWith('@media (hover: hover)') && !allowed.some((a) => a.test(line)))
      .map(({ line, i }) => `${i}: ${line.trim().slice(0, 90)}`);
    expect(offenders).toEqual([]);
    expect(readFileSync(join(chainUi, 'chain-ui.css'), 'utf8')).not.toMatch(/\.chain-icon:hover,/);
  });

  it('keeps toggle switches their own size on touch (the 40px button floor stretched them into tall blocks)', () => {
    const coarse = css.slice(css.indexOf('@media (pointer: coarse)'));
    expect(coarse.slice(0, coarse.indexOf('\n}'))).toContain('button.switch { min-height: 0; }');
    expect(css).toMatch(/\.switch \{\s*width: 30px; height: 18px; min-height: 0;/);
  });

  it('keeps fields at 16px on touch (iOS zooms the page in on smaller ones)', () => {
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{[^}]*input, select, textarea \{ font-size: 16px !important; \}/);
  });

  it('lets a dialog shrink to a phone\'s width, and sit above the bottom bar', () => {
    expect(rule(css, '.modal-backdrop')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(rule(css, '.modal')).toMatch(/max-width:\s*100%/);
    const z = (selector: string) => Number(/z-index:\s*(\d+)/.exec(css.slice(css.indexOf(`${selector} {`)))?.[1]);
    expect(z('.modal-backdrop')).toBeGreaterThan(z('.bottombar'));
    expect(z('.wallet-picker-backdrop')).toBeGreaterThan(z('.bottombar'));
  });
});
