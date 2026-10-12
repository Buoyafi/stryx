// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { chargeLogo, toggleTheme } from '../src/lib/brand';
import { Header } from '../src/components/Header';

afterEach(() => {
  cleanup();
  delete window.chargeLogo;
  delete window.toggleStryxTheme;
});

describe('brand wrappers', () => {
  it('do nothing, and do not throw, when theme.js is absent', () => {
    expect(() => chargeLogo()).not.toThrow();
    expect(() => toggleTheme()).not.toThrow();
  });

  it('call through to the theme.js globals when present', () => {
    window.chargeLogo = vi.fn();
    window.toggleStryxTheme = vi.fn();
    chargeLogo();
    toggleTheme();
    expect(window.chargeLogo).toHaveBeenCalledTimes(1);
    expect(window.toggleStryxTheme).toHaveBeenCalledTimes(1);
  });
});

describe('Header', () => {
  const renderHeader = () =>
    render(
      <MemoryRouter>
        <Header />
      </MemoryRouter>,
    );

  it('inlines the lockup as an svg (never an <img>) with the classes chargeLogo and brand.css need', () => {
    const { container } = renderHeader();
    const svg = container.querySelector('header svg.stryx-logo.stryx-lockup');
    expect(svg).not.toBeNull();
    expect(container.querySelector('header img')).toBeNull();
    expect(svg!.getAttribute('aria-label')).toBe('Stryx');
    // The X is split into a positioning group and the animated group.
    expect(svg!.querySelector('g > g.stryx-x')).not.toBeNull();
  });

  it('does not carry the source file\'s C2PA metadata into the page', () => {
    const { container } = renderHeader();
    expect(container.querySelector('metadata')).toBeNull();
    expect(container.innerHTML).not.toMatch(/c2pa/i);
  });

  it('wires the theme toggle to toggleStryxTheme()', () => {
    window.toggleStryxTheme = vi.fn();
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: /toggle dark and light mode/i }));
    expect(window.toggleStryxTheme).toHaveBeenCalledTimes(1);
  });
});

describe('Header lockup', () => {
  it('puts the atom in its own 64x64 viewport, so the theme-switch spin turns it in place', () => {
    const { container } = render(
      <MemoryRouter>
        <Header />
      </MemoryRouter>,
    );
    const lockup = container.querySelector('svg.stryx-lockup');
    const atom = lockup?.querySelector(':scope > svg[viewBox="0 0 64 64"]');
    expect(atom?.querySelector('.stryx-orbits')).toBeTruthy();
    expect(atom?.querySelector('.stryx-bolt')).toBeTruthy();
    expect(lockup?.querySelector('g[transform="translate(0 3) scale(2.6)"]')).toBeNull();
  });
});
