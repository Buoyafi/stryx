# Stryx: brand & UI spec

Reference doc for building the Stryx landing page and dashboard.

## Assets (in this folder)

| File | Use |
| --- | --- |
| `stryx-lockup.svg` | Mark + wordmark. Site header, hero, docs. |
| `stryx-mark.svg` | Atom mark alone. App icon, loading states, compact header. |
| `stryx-wordmark.svg` | Wordmark alone. Footer, places where the mark is redundant. |
| `favicon.svg` | Browser-tab icon for 16–32px. Standalone (fixed colours, dark tile), because a tab has no page CSS. White rings, lime bolt. |
| `brand.css` | Colour tokens, theme switching, logo animation. |
| `theme.js` | Theme init, toggle, and `chargeLogo()`. |
| `og-landing.png`, `og-app.png` | Link previews (1200×630) shown when gostryx.com or app.gostryx.com is shared in a chat or post. Referenced by absolute URL from each site's `index.html` (`og:image`). Dark theme, lime accent. |

**Inline the SVGs in markup** (not via `<img>` or `background-image`).
They use `currentColor` for the ink parts and `var(--stryx-accent)` for the
accent, so inlining is what lets them follow the theme.

## Logo

Atom mark: three electron orbital rings in ink with a lightning bolt as the
nucleus in the accent colour. The wordmark is Ethnocentric converted to
vector outlines: no webfont needed, and it never reflows. The final X is a
custom split-crosshair glyph drawn to the font's cap height (669/1000 em)
and stem weight, sitting on the same baseline.

Do not re-typeset the wordmark in a font; always use the SVG.

The X is drawn as `<g transform="translate(4180 0)"><g class="stryx-x">`. The
outer group positions it and the inner group is the one `brand.css` animates.
Keep them separate: a CSS `transform` replaces the `transform` attribute on the
same element, so animating the translated group would drop the translate and
throw the X across the wordmark for the length of the animation.

## Colour

| Token | Light | Dark |
| --- | --- | --- |
| `--stryx-accent` | `#7F77DD` violet | `#CCFF00` electric lime |
| `--stryx-on-accent` | `#FFFFFF` | `#0E0F0A` |
| `--stryx-bg` | `#F6F5FF` | `#0E0F0A` |
| `--stryx-card` | `#FFFFFF` | `#181A12` |
| `--stryx-ink` | `#14131F` | `#F4F6EC` |
| `--stryx-line` | `#E4E2F5` | `#2A2D20` |
| `--stryx-fail` | `#C0392B` | `#FF5C5C` |
| `--stryx-pending` | `#B26B00` | `#FFB020` |
| `--stryx-glow` | `#B9AEF6` light lilac | `#8F85E6` deeper lilac |

The accent swaps automatically with the theme. Never hardcode a hex value in
a component: always read the token. Text on an accent background must use
`--stryx-on-accent`; lime needs near-black, violet needs white.

Dark mode is the default aesthetic for Stryx; light mode is the alternate.
`theme.js` enforces this: with no saved choice it starts dark and ignores the
OS preference. The saved choice lives in `localStorage['stryx-theme']`, shared
by every app served from the same origin.

`--stryx-glow` is decorative only: the lilac second glow behind the landing page's
cards and background, and the secondary tone in a few charts. It is never used for
status, never for text, and never in place of the accent.

**Never blend the glow into the accent.** Opposite hues go muddy in the middle of a gradient
(lime and lilac turn grey-olive, violet and a warm tone turn dusty mauve). Gradients stay within
one hue (the accent to a lighter tint of itself); the glow is used as a separate wash or accent
beside it.

### Status colours

`--stryx-fail` and `--stryx-pending` exist only to signal state. Status must
never depend on colour alone: failed always carries a ✕ glyph, pending its own
glyph or spinner.

| State | Colour |
| --- | --- |
| live / confirmed | `--stryx-accent` |
| idle | `--stryx-sub` |
| pending | `--stryx-pending` |
| failed | `--stryx-fail` |

Small text in accent, fail or pending colour is below AA contrast on the light
theme. There, set small text in `--stryx-ink` and carry the colour with an
underline or the glyph instead. Buttons, dots and large elements may use the
colours directly.

## Motion

Electrons orbit continuously. On theme switch and on a successful mint, call
`chargeLogo()`: the electrons speed up, the orbits tilt, the bolt zaps, and
the crosshair X snaps. All of it is disabled under
`prefers-reduced-motion: reduce`.

Keep motion functional: it should mark a state change, never decorate idle UI.

## Mint states

The Operations view shows a scheduled mint's life as five states. Status never relies
on colour alone: each has its own glyph and a text label.

| State | Meaning | Colour | Glyph |
| --- | --- | --- | --- |
| scheduled | waiting, more than 60s away | `--stryx-sub` | hollow ring |
| armed | in its final 60s | `--stryx-pending` | spinning ring |
| minting | due, or broadcast and awaiting a receipt | `--stryx-pending` | spinning ring |
| confirmed | mined and succeeded | `--stryx-accent` | filled dot / ✓ |
| failed | did not mint, or reverted | `--stryx-fail` | ✕ |

"Armed" is a display state, not a scheduler state: every scheduled job fires at its
time, so scheduling already is arming, and there is no Arm button. In the final 60s
the countdown pulses in `--stryx-accent` (large text, so the accent is fine on both
themes); under reduced motion it stops pulsing and is underlined instead.

`chargeLogo()` replays on a mint's **confirmation** (a successful receipt observed as
it happens), never at broadcast and never for old history loading in.

## Mint outcomes chart and stat boxes

- **Series:** confirmed at the bottom of each stacked bar in `--stryx-accent`, failed on top
  in `--stryx-fail`. Failed is also hatched, so the two never differ by colour alone. The
  legend carries both series with their glyphs (✓, ✕). Colours are CSS variables on SVG
  classes, so the chart follows the theme switch with no code.
- **Empty and unknown are different.** An empty slot is a zero-height bar on a faint track,
  so the time axis stays even. A slot this device cannot vouch for is dotted and empty,
  labelled "Not recorded on this device", and is never drawn as zero.
- **Stat boxes (Confirmed and Failed)** both use the accent: a 2px `--stryx-accent` border
  and the count on a filled `--stryx-accent` block in `--stryx-on-accent`. Only the large
  count sits on the fill: on the light theme white on violet is about 3.6:1, which passes for
  large text and not for small, so small labels stay in ink on the card. The Failed box keeps
  its small `--stryx-fail` indicator with the ✕ glyph. The accent there is a highlight, not a
  meaning: the cross and the word "failed" carry the meaning.
- **Hidden text for screen readers** (`.sr-only`) goes on a wrapper `<div>`, never on a
  `<table>`: a table cannot shrink below its content, so a hidden table still widened the page.
- A hover rule must never override a selected state's accent fill.

## Sidebar (dashboards)

- **The atom is the logo on the dashboards.** The header lockup is gone there; the rail's
  atom is the trigger and the wordmark slides in beside it when the rail expands. The landing
  page and the sign-in screens keep the full lockup.
- **Collapsed by default:** a slim icon rail. Hover or keyboard focus expands it (labels
  appear, the electrons speed up briefly via the `is-charged` classes); moving away or Escape
  collapses it. Pinning keeps it open and is remembered, done by clicking the atom itself
  (there is no separate pin button: a second control for the same toggle was redundant).
  Never expand on a mouse click's focus, only on `:focus-visible`.
- **Connect wallet** lives in the footer, below Sign out. See the Connect wallet section.
- **Touch and narrow windows:** no hover, so tapping the atom opens a drawer with a backdrop;
  tapping outside or on a link closes it.
- **Active section:** a filled `--dash-raised` row with an accent edge. The icon and the label
  both show it, so it never depends on colour alone. Icons are the dashboard's own hand-drawn
  set (`lib/icons.tsx`, currentColor, 1.5 strokes); Disperse is one source fanning out to three.
- Reduced motion: no width transition, and the electrons stay still.

## Scrollbars

- **Hidden by default, everywhere; opt-in only.** `brand/brand.css` hides every scrollbar
  (`scrollbar-width: none` / `::-webkit-scrollbar { display: none }` on `*`) as the baseline
  across the landing page and both dashboards: content stays fully scrollable by wheel,
  touch and keyboard, it just never paints a bar. Nothing shows one unless it explicitly
  opts in. A component's own stylesheet never adds scrollbar CSS; change `brand/brand.css`
  instead.
- **`.stryx-scroll` opts a specific container back into the "Ghost" style.** Applied only to
  list boxes, dropdown panels, feeds, wallet lists, modals that can grow past their max
  height, and a table wrapper that can scroll horizontally, never to a whole page.
  - 6px wide (also 6px for a horizontal scrollbar on a wide table), transparent track, no
    arrow buttons.
  - Thumb is invisible at rest, fades in over ~200ms to `--stryx-accent` with fully rounded
    ends on hover or keyboard focus within the container. The accent follows the theme
    automatically (violet light, lime dark), same token as everywhere else.
  - Never fully hidden on a `.stryx-scroll` container: a touch device, with no hover to
    reveal it, keeps a faint thumb visible at rest (`--stryx-accent` at ~40% opacity via
    `color-mix`).
  - Chromium/WebKit via `::-webkit-scrollbar-*`; Firefox via `scrollbar-width`/
    `scrollbar-color`, gated behind `@supports not selector(::-webkit-scrollbar)` since
    Chrome 121+ lets the standard properties silently override the `::-webkit-scrollbar-*`
    styling otherwise.
- **The landing page** is long by design and keeps scrolling normally; its own bar is just
  hidden by the same default as everything else, no page-specific CSS needed.
- **Both dashboards are an app-shell layout**: the sidebar and header stay fixed
  (`.shell`/`.sidebar` are bounded to `100dvh`, not just a `min-height` floor), and only the
  main content region (`<main>`, inside `.shell__main`) scrolls its own content, invisibly,
  same default as everywhere else. Getting this right needed `.shell__main`'s flex child to
  carry `min-height: 0`, the classic trap where a flex child otherwise refuses to shrink
  below its content's natural height and the whole page scrolls at the body level instead.
- **Native `<select>` popups can't be styled by the page at all**, which is why none are
  left in either dashboard: all three (`MintOutcomesPanel.tsx`'s project filter,
  `SchedulesPage.tsx`'s chain picker, `NftTransferModal.tsx`'s chain picker) use the shared
  `Dropdown` component (`apps/dashboard/src/components/Dropdown.tsx`) instead, a real
  listbox styled with `--stryx-*` tokens, keyboard-accessible per the ARIA "select-only
  combobox" pattern (arrow keys, type-ahead, Escape, focus never leaves the trigger), whose
  option panel carries `.stryx-scroll`. The landing page has no native `<select>` at all
  today; if one is ever added there, it needs its own plain-DOM equivalent (`Dropdown` is
  React-only, living in `apps/dashboard`), not a port of this one.

## Disperse

- The chain is shown large on the review and results screens (shared `ChainIcon`, name, chain
  ID, mainnet or testnet). Per-recipient states use the agreed pills with glyphs: pending,
  confirmed, failed, plus unconfirmed and not sent. A problem row has a `--stryx-fail` edge on
  its first cell only, and the words say what is wrong.
- Small warning and error text follows the same rule as everywhere: ink or the token, with a
  glyph, never colour alone. The "you'll sign N times" note sits before the Review button, not
  after it.

## Hints

- **`GlowHint` (`apps/dashboard/src/components/GlowHint.tsx`) is for guidance, not for
  events.** It marks "here's the next useful thing to do" in an otherwise-empty or
  blocked state, e.g. Disperse's "Add at least one recipient to continue". A toast (see
  below) fires once when something *happens*; a hint sits still, pointing at what to do
  *next*, for as long as that's true. Never use one for the other: a hint is not a
  status message, and a toast is not a call to action.
- **Look**: a fully-rounded pill, `--stryx-card` background, a real 1.5px
  `--stryx-accent` border (always present, so there is never a broken or missing
  border), 13px medium-weight `--stryx-ink` text. A 26px leading circle, filled
  `--stryx-accent` with a glyph in `--stryx-on-accent` (`+` by default), pulses a soft
  accent ring every 2s. The border itself is animated: a thin rotating accent streak
  (a `conic-gradient` driven by a registered `@property --glow-angle`), one full turn
  every 3s, layered over the real static border rather than replacing it, so a browser
  that ignores `@property` (or any other pseudo-element hiccup) just shows the plain
  border underneath instead of nothing. Uses the accent colour deliberately, never
  `--stryx-pending`/`--stryx-fail`: this is an invitation, not a warning.
- **Behaviour**: focusable and clickable as a real `<button>` (`role="status"` so a
  screen reader announces it once without treating it as urgent); activating it moves
  focus to the most useful next control, e.g. the first recipient input. Fades and
  shrinks out (~200ms) the moment the blocked state resolves, fades back in if it
  recurs, owned entirely by the component (a caller just flips its `visible` prop).
  `prefers-reduced-motion`: no rotation, no pulse, just the plain static border and a
  solid icon, the same fallback used for no-`@property` support.
- Dashboard-only today, same as `Dropdown`: nothing on the landing page needs it yet.
  If that changes, it needs its own plain-DOM equivalent, not a port of this one.

## Connect wallet

- **One shared `ConnectWallet` component** (`apps/dashboard/src/components/connect-wallet/`),
  used in two places: the sidebar footer, below Sign out, and Disperse's source card. Both
  read the same connection (`useConnectedWallet()`, a `useSyncExternalStore` singleton, same
  shape as the mint feed's own store): connecting or disconnecting in one place shows in the
  other immediately. This is entirely separate from Stryx's own custodial wallets, and knows
  nothing about them; it only ever represents the operator's personal browser wallet. It will
  later be reused for the user dashboard's Sign-In With Ethereum.
- **Disconnected**: an accent pill, "Connect wallet", with a slow shimmer sweep (a moving
  highlight, not a pulsing ring: the app's other animations, `chain-icon-pulse` and
  `GlowHint`'s rotate/pulse, both signal state; this one signals "worth doing," so it reads
  differently on purpose). **Connected**: an account pill, a small gradient avatar
  deterministic from the address (`lib/avatar.ts`, hashed with the same `keccak_256` `wallet.ts`
  already uses, no lookup, no network call), the short address, and a connected dot in
  `--stryx-accent` (this app's existing token for every "live" indicator, and literally
  lime-green in the default dark theme). Clicking the account pill opens the account menu:
  copy address, the network the wallet is on (read only), "Use a different wallet" (lets this
  one go and opens the chooser), disconnect. No list of networks: a page that needs a chain
  (Disperse) picks it and moves the wallet there itself. The wallet is connected from the
  sidebar, the phone's More sheet and Disperse; Profile has no wallet section.
- **Disperse's card**: disconnected, an icon, "Connect a wallet to disperse," a one-line
  subtitle, and the same pill. Connected, the wallet's name, short address and native balance
  on the currently selected chain (only shown once the wallet is actually confirmed on that
  chain, never a stale balance from wherever it was before switching), clicking it opens the
  same account menu the sidebar pill does, rather than a separate disconnect-only control.
- **The wallet picker** (bottom sheet on mobile, centred modal from 640px up, 20px corner
  radius, deliberately larger than the shared 6px `--radius` every other modal uses). Headed
  "Connect to" in heavy, widely spaced capitals beside the real wordmark SVG (never re-typeset),
  centred, with a one-line purpose under it ("Choose the wallet to use." or "Sign in with your
  wallet"). A "Detected" section first: EIP-6963 wallets found in this browser, each with its
  own announced name and icon, tagged "Detected". An old-style `window.ethereum` wallet is named
  from the flag it sets (`isRabby`, `isPhantom`, ...) and left out when that wallet also announced
  itself. Then "Phone wallet" (WalletConnect, when a project ID is set), then "More wallets":
  known wallets not detected here, linking to each one's official site in a new tab, never
  claimed as detected. Wallet logos: the wallet's own announced icon first; otherwise its mark
  from `apps/dashboard/public/wallets/` (taken from RainbowKit, MIT; each mark belongs to its
  wallet and is used only to identify it in this list). A wallet we hold no logo for gets a
  plain monogram badge in the app's own tokens. Picking a detected wallet shows a waiting
  state ("Approve in your wallet" + a spinner) until it resolves; a rejection or no response
  (a 60s timeout) shows a clear message, never a stuck spinner. Footer line: "Stryx never sees
  your private keys."
- **Accessible**: `role="dialog"` `aria-modal="true"`, a real focus trap (Tab/Shift+Tab cycle
  within it, built from scratch here since nothing else in this app has one to reuse), Escape
  and scrim-click close it, focus moves in on open and returns to the trigger on close. The
  account menu is a lighter dismissible popover (outside-click and Escape close it), not a
  full dialog: focus never has to move into it for it to be usable.
- Tokens only throughout; nothing here hardcodes a colour.

## Toasts

- **One shared service, `@stryx/toast-ui`, used everywhere** (`apps/dashboard/src/App.tsx`
  mounts `<ToastHost />` once, `apps/landing/src/main.js` calls `mountToastHost()` once): no
  page builds its own toast. Import `{ toast }` and call `toast.success/error/info(title,
  detail?)` from anywhere.
- **Look**: a fully-rounded pill, `--stryx-card` background, 1px `--stryx-line` border. A
  20px dismiss circle at the front (`--stryx-bg` fill, `--stryx-sub` ✕ turning
  `--stryx-ink` on hover/focus), then a 6px status dot, then bold title + muted detail on
  one line. Error uses `--stryx-fail`, success `--stryx-accent`, info `--stryx-pending`, same
  status-never-by-colour-alone rule as everywhere else (each tone also gets its own
  `role="alert"`/`role="status"` for screen readers, not just a colour). A 2px progress line
  along the bottom shows time remaining and pauses on hover or focus.
- **Position and limits**: bottom-centre on a narrow viewport, bottom-right above it,
  clear of `env(safe-area-inset-*)`. At most 3 visible; a new one evicts the oldest. Errors
  auto-dismiss after 6s, success/info after 3.5s; an error carrying a retry-style action
  button stays until dismissed instead.
- **What becomes a toast vs. what stays inline**: page-level and system events (RPC/OpenSea
  unavailable, a mint sent or confirmed, a schedule created or cancelled, a transfer or
  disperse batch finishing, settings saved). Per-wallet or per-row reasons and form
  validation errors are never a toast, not even one per item in a batch. Where an action already
  shows a durable inline result (an explorer link, a CSV/done view, a per-item results
  table), the toast supplements it as an ambient ping rather than replacing it.

## Voice of the UI

Clean and minimal, with a light playful edge. Short labels, generous spacing,
one accent colour doing the work.

## Planned UI (not built yet)

- Chain rail: chains shown by **logo only**, with a live status dot (RPC health).
  Chain icons come from the central chain registry (`@stryx/chains`, its `icon` field:
  a committed SVG in `packages/chains/icons/`), never hardcoded and never hotlinked.
  On hover, keyboard focus or tap: chain name, chain ID, mainnet or testnet, gas token.
  Built as the shared `@stryx/chain-ui` (`ChainIcon` and `ChainTooltip`), used by both
  the landing page and the dashboard. The dashboard's tooltip adds API and RPC status
  from data it already has; live gas needs a backend endpoint that does not exist yet.
- ~~Mint cards with live countdowns; final 60s pulses.~~ Built: the dashboard's
  Operations view (see "Mint states" below).
- ~~Live mint feed: pending → confirmed, with explorer links.~~ Built, with the
  limits described below.
- Allow-list eligibility checker (paste wallet + drop).
- Wallet health grid: balance per chain, nonce, low-gas warning.
- Dry-run/simulate before committing funds.
- Command palette (⌘K) for jumping to any drop, wallet, or chain.
- Landing page: hero → how it works (3 steps) → services → supported chains →
  security → FAQ → waitlist.
