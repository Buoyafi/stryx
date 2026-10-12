import { chainIconMarkup } from '@stryx/chain-ui';

/** Pure: given chains from the central registry (@stryx/chains), returns the inner HTML for the "Chains" section's logo grid. */
export function buildChainGridMarkup(chains, { status = 'live' } = {}) {
  // Testnets are never on this public page: it shows the networks a visitor can actually mint on.
  return chains.filter((chain) => !chain.isTestnet).map((chain) => `<li class="chain-grid__item">${chainIconMarkup(chain, { status, focusable: true })}</li>`).join('');
}

/** How many real networks the registry lists (testnets are neither shown nor counted). */
export function mainnetCount(chains) {
  return chains.filter((chain) => !chain.isTestnet).length;
}
