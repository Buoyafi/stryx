// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CollectionThumb } from '../src/components/CollectionThumb';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CollectionThumb: external (OpenSea-hotlinked) images', () => {
  it('renders an <img> pointed straight at the external URL', () => {
    render(<CollectionThumb image={{ kind: 'external', url: 'https://i.seadn.io/x.png' }} name="Cool Drop" contract="0xAbc" />);
    expect(document.querySelector('img')?.getAttribute('src')).toBe('https://i.seadn.io/x.png');
  });

  it('falls back to the monogram tile on a load error', () => {
    render(<CollectionThumb image={{ kind: 'external', url: 'https://i.seadn.io/broken.png' }} name="Cool Drop" contract="0xAbc" />);
    const img = document.querySelector('img')!;
    fireEvent.error(img);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('C')).toBeTruthy(); // first letter of "Cool Drop"
  });
});

describe('CollectionThumb: proxied (contract-metadata) images', () => {
  it('fetches the proxied URL as an authenticated blob and renders it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe('/api/chains/46630/collections/0xAbc/image');
      return { ok: true, blob: async () => new Blob(['x']) };
    }));
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() });

    render(<CollectionThumb image={{ kind: 'proxied', url: '/chains/46630/collections/0xAbc/image' }} name={null} contract="0xAbc" />);

    const img = await screen.findByRole('presentation', { hidden: true });
    expect((img as HTMLImageElement).src).toContain('blob:fake');
  });

  it('shows the monogram (not a broken image) while the proxied fetch is still pending, then the monogram on failure', async () => {
    let resolveFetch: (v: { ok: boolean; blob: () => Promise<Blob> }) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; })),
    );

    render(<CollectionThumb image={{ kind: 'proxied', url: '/x' }} name={null} contract="0xAbc" />);

    // No name and a contract starting with the letters "0xAbc": first letter after 0x is "A".
    expect(screen.getByText('A')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();

    resolveFetch({ ok: false, blob: async () => new Blob() });
    await screen.findByText('A'); // still the monogram once the fetch resolves as a failure
    expect(document.querySelector('img')).toBeNull();
  });

  it('falls back to "?" when there is neither a name nor a usable contract character', () => {
    render(<CollectionThumb image={null} name="" contract="" />);
    expect(screen.getByText('?')).toBeTruthy();
  });

  it('revokes the object URL on unmount', async () => {
    const revoke = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x']) })));
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: revoke });

    const { unmount } = render(<CollectionThumb image={{ kind: 'proxied', url: '/x' }} name={null} contract="0xAbc" />);
    await screen.findByRole('presentation', { hidden: true });
    unmount();

    expect(revoke).toHaveBeenCalledWith('blob:fake');
  });
});
