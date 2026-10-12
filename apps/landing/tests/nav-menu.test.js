// @vitest-environment jsdom
/* global document, KeyboardEvent */
import { beforeEach, describe, expect, it } from 'vitest';
import { mountNavMenu } from '../src/lib/nav-menu.js';

function setup() {
  document.body.innerHTML = `
    <details class="nav-menu">
      <summary class="nav-menu__toggle">Menu</summary>
      <nav class="nav-menu__panel"><a href="#how">How it works</a><a href="#faq">FAQ</a></nav>
    </details>
    <main><p id="elsewhere">The page</p></main>`;
  const menu = document.querySelector('.nav-menu');
  mountNavMenu(menu);
  const open = () => menu.setAttribute('open', '');
  return { menu, open };
}

describe('mountNavMenu', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('closes on a click anywhere outside the menu', () => {
    const { menu, open } = setup();
    open();
    document.getElementById('elsewhere').click();
    expect(menu.hasAttribute('open')).toBe(false);
  });

  it('stays open for a click inside the panel that is not a link', () => {
    const { menu, open } = setup();
    open();
    menu.querySelector('.nav-menu__panel').click();
    expect(menu.hasAttribute('open')).toBe(true);
  });

  it('closes once a link is chosen', () => {
    const { menu, open } = setup();
    open();
    menu.querySelector('a').click();
    expect(menu.hasAttribute('open')).toBe(false);
  });

  it('closes on Escape and puts focus back on the menu button', () => {
    const { menu, open } = setup();
    open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(menu.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(menu.querySelector('summary'));
  });

  it('a click elsewhere while it is closed changes nothing, and a missing menu is ignored', () => {
    const { menu } = setup();
    document.getElementById('elsewhere').click();
    expect(menu.hasAttribute('open')).toBe(false);
    expect(() => mountNavMenu(null)).not.toThrow();
  });
});
