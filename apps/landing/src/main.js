import '@fontsource-variable/inter';
import '@stryx/chain-ui/chain-ui.css';
import '@stryx/toast-ui/toast-ui.css';
import { CHAINS } from '@stryx/chains';
import { mountChainTooltips, viewForChainId } from '@stryx/chain-ui';
import { mountToastHost } from '@stryx/toast-ui';
import { buildChainGridMarkup, mainnetCount } from './lib/chain-rail.js';
import { mountAccordion } from './lib/accordion.js';
import { mountAppLinks, resolveAppUrl } from './lib/app-link.js';
import { mountBackground } from './lib/background.js';
import { mountCardLight } from './lib/card-light.js';
import { mountDropsStrip } from './lib/drops-strip.js';
import { legalLinksOn, mountLegalLinks } from './lib/legal-links.js';
import { mountScrollReveal } from './lib/reveal.js';
import { mountSpeedDemo } from './lib/speed-demo.js';
import { mountWaitlistForm } from './lib/waitlist.js';
import { mountNavMenu } from './lib/nav-menu.js';

// The theme toggle button calls the global `toggleStryxTheme()` from /brand/theme.js directly.

const grid = document.getElementById('chain-grid');
if (grid) grid.innerHTML = buildChainGridMarkup(CHAINS);

// "15 chains" is read from the registry, so it can never drift from the grid below it.
document.querySelectorAll('[data-chain-count]').forEach((el) => { el.textContent = String(mainnetCount(CHAINS)); });

// Static registry facts only (name, chain ID, network, gas token).
mountChainTooltips({ resolve: (chainId) => ({ chain: viewForChainId(chainId) }) });

mountToastHost();

// "Sign in" and "Open the app" appear only when the app's address is configured (VITE_APP_URL).
mountAppLinks(resolveAppUrl(import.meta.env));
// Links to the Terms and Privacy pages appear once they are published (VITE_LEGAL_LINKS=true).
mountLegalLinks(legalLinksOn(import.meta.env));

// On a phone the menu closes once a link is chosen, or on a tap anywhere outside it.
mountNavMenu(document.querySelector('.nav-menu'));
mountBackground(document.getElementById('bg-canvas'));
mountSpeedDemo(document.querySelector('[data-speed-demo]'), { freeze: new URLSearchParams(window.location.search).get('race') });
mountCardLight();
mountAccordion(document.getElementById('faq-list'));
// Posts to the API's POST /waitlist through the same /api path as the drops strip (see below).
const apiBase = import.meta.env.VITE_API_URL || '/api';
mountWaitlistForm(document.getElementById('waitlist-form'), { apiBase });

// The drops strip reads the API's public feed through the same-origin /api path.
void mountDropsStrip(document.querySelector('[data-drops]'), { apiBase });

// The scheduled-drops card's example countdown ticks down and loops.
const countdown = document.querySelector('[data-countdown]');
if (countdown && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  let left = 7;
  setInterval(() => {
    left = left <= 0 ? 59 : left - 1;
    countdown.textContent = `00:00:${String(left).padStart(2, '0')}`;
  }, 1000);
}

// Last, so every block it animates is already in the page.
mountScrollReveal();

const yearEl = document.getElementById('footer-year');
if (yearEl) yearEl.textContent = String(new Date().getFullYear());
