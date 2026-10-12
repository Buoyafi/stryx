# Stryx landing page

Public marketing site: plain HTML/CSS/JS, no framework, served in dev by Vite
purely for hot reload and a real `build` later. `theme.js`'s API
(`toggleStryxTheme`, `chargeLogo`) is deliberately plain-script/global, so the
page stays framework-free to match it.

## Run it

```bash
npm install
npm run dev       # http://localhost:5174 (or whatever Vite picks)
npm run build     # static output in dist/
npm run test      # vitest: pure logic only, see tests/
```

## Brand assets

`index.html` links `/brand/brand.css`, `/brand/theme.js`, and
`/brand/favicon.svg` by **absolute** path. `public/brand` is a symlink to the
repo-root `brand/` folder: Vite serves `publicDir` at the URL root in dev
*and* copies it verbatim into `dist/` on `build`, so the same absolute path
resolves correctly both ways with no duplication and no build step of its
own. `brand/` at the repo root stays the single source of truth.

(A relative path: `../../brand/...`, matching the real filesystem location
from `apps/landing/index.html`: does **not** work here: the browser resolves
it against the served URL root, not the filesystem, and a dev server's
document root is `apps/landing/`, not the repo root. Caught this live: the
first version of this page 404'd on `theme.js` for exactly this reason.)

Every logo SVG (`stryx-lockup.svg` in the header, `stryx-wordmark.svg` in the
footer) is inlined directly in `index.html`, copied verbatim from `brand/`
**except** the embedded C2PA `<metadata>` block, which is stripped: it
describes the source *file* as an artifact, not this composite page, and
would otherwise re-embed several KB of opaque provenance data per logo
instance for no benefit to the page. Both inlined copies also gain
`class="stryx-logo"` (not present in the source files), which is what lets
`theme.js`'s `chargeLogo()` find and replay them.

The header lockup is sized by `.stryx-lockup` in `brand/brand.css` (atom mark
about 40px, wordmark cap height about 18px on desktop, 80% on mobile), so the
page CSS only sets header spacing. `apps/dashboard` uses the same lockup and
the same `/brand` wiring.

## The page

Top to bottom: a hero, a **stage** (a simulated speed demo with floating glass cards), the
**live drops strip**, How it works, Services, Chains, Security, FAQ and the waitlist. A canvas of
drifting physics equations sits behind everything, and content rises into place from underneath as
you scroll. Where each piece lives (`src/lib/`):

| File | What it does |
| --- | --- |
| `background.js` | The canvas: equations and numbers, plus ripples across the top of the hero. A calm zone sits behind the headline; everything steps back as you scroll. Static under reduced motion. |
| `speed-demo.js` | The stage demo: eight wallets mint the moment a stage opens, with a clock and a "by hand" lane. **A simulation**: timings are invented per run, play at 0.25x, and the page labels it so. `?race=mid` / `?race=done` freeze it (for screenshots). |
| `drops-strip.js` | The live strip. Reads `GET /home/drops` (public, cached on the server). If the feed is unreachable or has fewer than 4 drops the section stays hidden; it never falls back to invented drops. `?sample=1` shows made-up drops (`sample-drops.js`) to preview the design. |
| `reveal.js` | The rise-from-underneath reveal. Everything is visible without it; `.rise-armed` is added only once it is watching. Skipped under reduced motion. |
| `card-light.js` | The pointer-following glow on cards (hover devices only). |

The strip needs the API: in dev, Vite proxies `/api` to `http://localhost:3000` (`vite.config.js`);
in production the host's reverse proxy should do the same, or set `VITE_API_URL` to the API host
at build time. The API sends no CORS headers, so a separate host needs the proxy.

**The waitlist.** The form posts the email to the API (`POST /waitlist`, through the same `/api` path as the
drops strip; `lib/waitlist.js`). The API stores it and answers the same whether or not the address was
already there. A hidden `leave_blank` field is a trap for scripts. Admins see the list, mark people invited,
export a CSV and remove people in the dashboard's Admin > Waitlist tab.

**Terms and Privacy pages.** `terms.html` and `privacy.html` are templates filled at build time (and in dev)
from `docs/legal` by `vite-legal-plugin.js`: it uses `terms-of-use.md` / `privacy-policy.md` when they
exist, else the `-DRAFT` files. A document that still starts with the draft note shows a visible "Draft"
banner and `noindex`. The "SIGN-UP ACCEPTANCE" section (how the app records acceptance) is left out of the
public page. To publish: finish the text, rename the files to drop `-DRAFT`, delete the draft note, then
build with `VITE_LEGAL_LINKS=true` so the footer links appear. The pages are `/terms.html` and
`/privacy.html` (plain files, so any static host serves them with no rewrite rules). Markdown notes:
paragraph lines join like normal Markdown; a line ending in a backslash is a hard break.

**Getting into the app.** "Sign in" (header, phone menu, footer) and "Already have an access code? Open the
app →" (under the waitlist form) go to the dashboard, whose address is set at build time with
`VITE_APP_URL` (`lib/app-link.js`). In dev it defaults to `http://localhost:5173`; in a production build
with it unset the links are hidden rather than dead. The dashboard's own "Join the waitlist" goes the other
way, via its `VITE_WAITLIST_URL`.

`--stryx-glow` (a lilac second glow, decorative only; never blended into the accent) is a brand token: see `brand/BRAND.md`.

## Chain data

The "Chains" grid renders `CHAINS` from `@stryx/chains`, the
central registry (`packages/chains`), which is also what the API and the dashboard
read. There is no chain list in this app. Each entry carries an `icon` (a committed
SVG in `packages/chains/icons/`, bundled by Vite, never fetched from anywhere else)
and `isTestnet`, `nativeCurrency` and `openSeaChainName`.

The icon, the "T" testnet badge, the lettered fallback (for a chain with no icon) and
the hover, focus and tap tooltip are the shared `@stryx/chain-ui` package, the same one
the operator dashboard uses. The tooltip is one element appended to `<body>` with
`position: fixed`, so `overflow: hidden` on a parent cannot clip it. It shows static
registry facts only (name, chain ID, network, gas token): this page never makes a live
RPC call, so a public visitor can never trigger one.

The "15 chains" figures are the registry's mainnet count, read at load (`mainnetCount`).

`status` on the dots is a static display value (`'live'`, applied to every chain by
`lib/chain-rail.js`), not a health check.

`@stryx/chains` is consumed from its built `dist/` like every other package, so run
`npm run build -w @stryx/chains` after a fresh install or after changing it.
