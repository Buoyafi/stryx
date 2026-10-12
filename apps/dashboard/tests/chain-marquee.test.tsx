// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { CHAINS } from '@stryx/chains';
import { ChainMarquee } from '../src/components/ChainMarquee';

afterEach(cleanup);

describe('ChainMarquee', () => {
  const mainnets = CHAINS.filter((c) => !c.isTestnet);

  it('says how many chains, and lists each mainnet once for people and assistive tech', () => {
    render(<ChainMarquee />);
    const region = screen.getByRole('region', { name: `Supported chains: ${mainnets.length}` });
    expect(within(region).getByText(`Works on ${mainnets.length} chains`)).not.toBeNull();
    const real = within(region).getAllByRole('button');
    expect(real).toHaveLength(mainnets.length);
    expect(real.map((b) => b.getAttribute('aria-label'))).toEqual(mainnets.map((c) => c.name));
  });

  it('leaves testnets out', () => {
    render(<ChainMarquee />);
    for (const t of CHAINS.filter((c) => c.isTestnet)) expect(screen.queryByRole('button', { name: t.name })).toBeNull();
  });

  it('loops with a second, decorative copy that is hidden from assistive tech and not focusable', () => {
    const { container } = render(<ChainMarquee />);
    const tracks = container.querySelectorAll('.marquee__track');
    expect(tracks).toHaveLength(2);
    expect(tracks[0]!.getAttribute('aria-hidden')).toBeNull();
    expect(tracks[1]!.getAttribute('aria-hidden')).toBe('true');
    expect(tracks[1]!.querySelectorAll('button')).toHaveLength(0);
    expect(tracks[1]!.querySelectorAll('.chain-icon')).toHaveLength(mainnets.length);
  });
});
