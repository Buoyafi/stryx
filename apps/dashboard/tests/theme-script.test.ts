// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(__dirname, '../../../brand/theme.js'), 'utf8');
// Runs the script as a page would, returning its toggle.
const load = () => new Function(`${source}; return toggleStryxTheme;`)() as () => void;

afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
});

describe('brand/theme.js', () => {
  it('with storage blocked, still sets the theme and the toggle still switches it', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    const toggle = load();
    expect(document.documentElement.dataset.theme).toBe('dark');
    toggle();
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('ignores a stored value that is not a theme', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('purple');
    load();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
