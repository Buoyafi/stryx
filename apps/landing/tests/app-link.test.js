import { describe, expect, it } from 'vitest';
import { mountAppLinks, resolveAppUrl } from '../src/lib/app-link.js';

describe('resolveAppUrl', () => {
  it('uses the configured address when it is https', () => {
    expect(resolveAppUrl({ VITE_APP_URL: 'https://app.stryx.example' })).toBe('https://app.stryx.example/');
    expect(resolveAppUrl({ VITE_APP_URL: '  https://app.stryx.example/start  ' })).toBe('https://app.stryx.example/start');
  });

  it('allows plain http only on localhost', () => {
    expect(resolveAppUrl({ VITE_APP_URL: 'http://localhost:4173' })).toBe('http://localhost:4173/');
    expect(resolveAppUrl({ VITE_APP_URL: 'http://127.0.0.1:5173' })).toBe('http://127.0.0.1:5173/');
    expect(resolveAppUrl({ VITE_APP_URL: 'http://app.stryx.example' })).toBeNull();
  });

  it('rejects anything that is not a web address, so a bad setting never becomes a link', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://x.example', 'app.stryx.example', '//app.stryx.example', 'not a url']) {
      expect(resolveAppUrl({ VITE_APP_URL: bad, DEV: true })).toBeNull();
    }
  });

  it('defaults to the dashboard dev server in development and to nothing in production', () => {
    expect(resolveAppUrl({ DEV: true })).toBe('http://localhost:5173');
    expect(resolveAppUrl({ VITE_APP_URL: '', DEV: true })).toBe('http://localhost:5173');
    expect(resolveAppUrl({})).toBeNull();
    expect(resolveAppUrl({ DEV: false })).toBeNull();
    expect(resolveAppUrl()).toBeNull();
  });
});

describe('mountAppLinks', () => {
  const el = () => ({ hidden: true, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
  const rootOf = (links, wrappers) => ({ querySelectorAll: (sel) => (sel === '[data-app-link]' ? links : wrappers) });

  it('points every link at the app and reveals links and their wrappers', () => {
    const links = [el(), el()];
    const wrappers = [el()];
    mountAppLinks('https://app.stryx.example/', rootOf(links, wrappers));
    expect(links.every((a) => a.attrs.href === 'https://app.stryx.example/' && a.hidden === false)).toBe(true);
    expect(wrappers[0].hidden).toBe(false);
  });

  it('leaves everything hidden when there is no app address', () => {
    const links = [el()];
    const wrappers = [el()];
    mountAppLinks(null, rootOf(links, wrappers));
    expect(links[0].hidden).toBe(true);
    expect(links[0].attrs.href).toBeUndefined();
    expect(wrappers[0].hidden).toBe(true);
  });
});
