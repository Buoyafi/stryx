# ADR-003: Wallet-Signed Identity, Accounts, the Mint Event Log and Operator Analytics

**Status:** Design decisions confirmed (§8, 2026-09-21); nothing here is built yet. Numbering settled as ADR-003. Legal review of the notice, terms and jurisdiction (§4.13) remains outstanding and gates external users, not the build itself.
**Date:** 2026-09-21
**Owners:** Platform Architecture
**Affected modules:** API (auth, sessions, every controller), Database schema and roles, Key Management, Transaction Engine (one signing hook), Mint Scheduler, Dashboard (sign-in, Operations, Disperse), Landing (terms and privacy pages)
**Supersedes, in part:** ADR-002 §3.2 (`User.email`, `passwordHash`), §3.4 (password authentication, password recovery, the `/auth/signup` and `/auth/login` routes) and the password items in §3.9, §4 and §8. Everything else in ADR-002 stands: the custody decision, §3.3 structural ownership, §3.5 roles, §3.6 to §3.8, §3.10 and §3.11, except where a section below says otherwise.

**A note on numbering, resolved (§8.1).** The brief asked for this as ADR-002. That file already exists, is implemented (six commits, live-verified), and covers a different decision (custody and ownership). Overwriting it would erase the record of what the running code was built against, so this is ADR-003, and ADR-002 is kept with its superseded passages marked in place rather than rewritten.

---

## 1. Context

Stryx is a single-operator tool that has grown a multi-user backend with no user-facing front door. ADR-002 gave it password accounts. This ADR changes three things:

1. **Identity becomes a wallet signature** (Sign-In With Ethereum), not an email and password. Crypto users already hold the credential, there is no password database to breach or reset, and the account and its terms acceptance are created by the same signature.
2. **The server becomes the record of what happened.** Today the mint feed, the outcomes chart and the stat boxes are rebuilt in each browser from `localStorage` plus a 24-hour BullMQ window. That cannot serve multiple users, cannot serve the operator, and cannot answer "how many mints failed last week".
3. **The operator gets platform-wide analytics**, which makes the operator account the highest-value target in the system and forces decisions about how it is designated, protected and audited.

The custody model (ADR-001, ADR-002 §1) is unchanged. Stryx holds the encrypted keys of the bot wallets so scheduled mints can sign unattended. SIWE proves who the user is. It does not, and must not, become the key that decrypts their bot wallets: that would make unattended signing impossible.

## 2. What the code does today (verified against code on 2026-09-21)

`CONTEXT.md` lags the code (see the project's own history of this), so each claim below was checked in source, not taken from the docs.

| Area | Finding | Where |
|---|---|---|
| Auth | Email plus argon2id password. `POST /auth/signup` and `/auth/login` are in `PUBLIC_PATHS`, so **anyone who can reach the API can create an account today**. | `apps/api/src/auth.ts:32`, `user-auth-controller.ts` |
| Sessions | Opaque token, SHA-256 keyed in Redis, sliding 7 days, absolute 30 days. Returned in the JSON body and sent as a `Bearer` header. The dashboard keeps it in `sessionStorage`. **No cookie, no CORS, no rate-limit plugin** exists in `apps/api`. | `session-store.ts`, `apps/dashboard/src/lib/api.ts:16`, `apps/api/package.json` |
| Mass revocation | ADR-002 §3.9 promised a `user_sessions:{userId}` index. **It was never built** (no match anywhere). Only one session at a time can be revoked. | repo-wide grep |
| Operator | Reserved user `00000000-...-0001`, role `ADMIN`, `passwordHash` a `disabled:` placeholder, authenticated by the shared `API_AUTH_TOKEN`, which resolves to that user with full ADMIN rights. | migration `20260913092515`, `auth.ts:68` |
| Admin routes | `requireAdmin` is called by hand at the top of each admin handler. Only the emergency-stop routes use it. | `emergency-stop-controller.ts:45` |
| Mint history | None on the server. The audit log records `mint.public` and `mint.allowlist` (no chain, no contract, no tx hash), and **scheduled mints are never audited**. The feed and chart read `localStorage['stryx-mint-feed-v1']` (1,000 rows) plus BullMQ jobs kept 24 hours. | `mint-controller.ts:44`, `mint-scheduler.ts:140`, `mint-feed-store.ts` |
| Confirmation | No server-side tracking. `TransactionResult` is `{hash, nonce, status: 'broadcast'}`, with no gas used. The dashboard polls the receipts route. | `transaction.types.ts:46`, `wallet-ops-controller.ts:139` |
| Schedules | Creation carries `ownerId` and the worker re-checks it when the job fires. **`GET /schedules/mints` calls `mintScheduler.list()` with no owner filter and `DELETE /schedules/mints/:jobId` cancels any job by id.** `list()` also reads only the first 100 jobs across all users. `CONTEXT.md` says scheduled mints are wired end to end: true for firing, false for listing and cancelling. | `schedule-controller.ts:86-146`, `mint-scheduler.ts:155` |
| Allow-lists | `InMemoryAllowListStore`, one global key space, no HTTP route writes to it today. | `allowlist-store.ts`, `server.ts:95` |
| Wallet addresses | `wallets.address` is globally unique and `existsByAddress` is deliberately global, so importing an address that any user holds returns 409. | `wallet.service.ts:128` |
| Audit log | Insert-only for `stryx_app` at the Postgres level. Good, and it means rows cannot be redacted or pruned by the app. | `provision_app_role` migration |
| Future tables | `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stryx_app` means **every new table is fully writable and deletable by the app role by default**. The role's password is hard-coded (`stryx_app_dev_only`) in the migration. | same migration |
| KMS | `KeyManagementProvider.wrapDek(dek)` and `unwrapDek(wrapped)` take no encryption context. The signing path looks up key material by wallet id with no owner (the gap ADR-002 records). | `key-management/src/types.ts:36` |
| Broadcast | The signed transaction exists before `sendRawTransaction` runs, so its hash is computable before broadcast. Today the hash is only surfaced after. | `transaction-engine.service.ts:104` |
| SIWE library | `viem` 2.55.11 is already installed and ships `viem/siwe` (message build, parse, validate, verify, nonce). No new dependency. | `node_modules/viem` |

Two consequences drive the build order in §7. The API must not be reachable by untrusted callers until open signup and the schedule scoping gap are closed. And the audit log's immutability is a feature for security records but rules it out as the mint history, which needs mutable status.

## 3. Decided (from the brief, not reopened here)

- **Auth:** SIWE (EIP-4361), EVM wallets only. The first successful sign-in creates the account and records acceptance of the terms. Nothing on the user dashboard is reachable before sign-in.
- **Email:** optional, for updates only, verified before use.
- **Discord:** optional linking via OAuth2, scope `identify`, only after wallet sign-in, never a sign-in method. Stores Discord user id, username and avatar only. Unlinking deletes them.
- **Profile:** optional display name and avatar (Discord avatar if linked, otherwise generated from the wallet address).
- **Operator:** has platform-wide visibility for analytics.

## 4. Decisions on the open questions

### 4.1 SIWE: nonce, storage, expiry, domain binding

**Options for the message.** (a) The client builds the EIP-4361 message and the server validates it. (b) The server builds the exact message and the client signs it verbatim.

**Options for the nonce.** (a) Stateless (HMAC of a timestamp): no single-use guarantee, so a captured signature replays until expiry. (b) Postgres row: durable but pointless for a five-minute value. (c) Redis, single use, short TTL.

**Recommendation.**

- The server builds the message. `POST /auth/siwe/challenge {address, chainId}` returns `{message}`. `POST /auth/siwe/verify {message, signature}` completes sign-in. Wording, terms version and expiry then cannot drift between client and server, and the server re-parses and compares every field against what it issued.
- Nonce: 128 bits from a CSPRNG, alphanumeric (EIP-4361 requires at least 8 alphanumeric characters; viem's `generateSiweNonce` or an equivalent). Stored in Redis as `siwe:nonce:{sha256(nonce)}` with `{address, chainId, issuedAt}`, TTL 5 minutes. **Consumed with an atomic `GETDEL` at verify time, before the signature is checked**, so a failed attempt also burns the nonce and there is no retry oracle.
- Expiry: the message carries `expirationTime = issuedAt + 5 min`. The server rejects a stale `issuedAt`, one more than 60 seconds in the future, or an `expirationTime` beyond 5 minutes.
- Domain binding: `domain` must equal the configured `APP_DOMAIN` exactly (host and port), `uri` must be `APP_ORIGIN`, `version` must be `1`, and `address` must equal the challenge's address. All values come from server config, never from the request.
- `chainId` is accepted only if it is in `@stryx/chains`. It is informational for an EOA (no RPC call is made) and load-bearing only for EIP-1271 (§4.3).
- Address handling: parse with `getAddress`, store canonical EIP-55, enforce uniqueness on the lowercase form. Mixed-case input that fails its checksum is rejected, never silently fixed (same rule as Disperse).
- **One uniform message for everyone**, sign-in and sign-up alike, so the challenge never reveals whether an address has an account:

  ```
  stryx.example wants you to sign in with your Ethereum account:
  0xAbC...
  
  Sign in to Stryx. By signing you accept the Terms (v1) at https://stryx.example/terms and the Privacy Notice. This does not send a transaction or cost gas.
  
  URI: https://stryx.example
  Version: 1
  Chain ID: 1
  Nonce: 7Xk2...
  Issued At: 2026-09-21T10:00:00Z
  Expiration Time: 2026-09-21T10:05:00Z
  ```

  If the address has no account, a successful verify creates one and writes a `terms_acceptances` row. If it has one, the sign-in is recorded and, when the terms version has moved, a new acceptance row is written. Re-acceptance on a terms change falls out of the design with no extra flow.
- Rate limits (new dependency, `@fastify/rate-limit` on the existing Redis): challenges per IP and per address, verify failures per IP, and a cap on outstanding nonces per IP.
- Login CSRF (an attacker submitting their own signature from the victim's browser) is closed by §4.2: no CORS, `SameSite=Lax`, and an `Origin` check on every non-GET request. Binding the nonce to a client cookie was considered and rejected: it adds state without adding protection beyond that.
- Binding the nonce to the client IP was rejected: mobile and carrier-NAT users change addresses mid-flow and would fail sign-in for no security gain.

**Known limit, stated plainly.** SIWE cannot stop a phishing site from asking a user to sign a message that names the real domain and relaying it. The defence is wallet-side domain-mismatch warnings plus §4.2's action-bound step-up for anything that moves money, and it is analysed in §4.14.

### 4.2 Sessions

**Options.** (a) Keep the bearer token in `sessionStorage` (today). (b) httpOnly cookie holding the same opaque Redis-backed token. (c) JWT (already rejected in ADR-002, still rejected: it cannot be revoked instantly).

**Recommendation.** (b), keeping the ADR-002 store and extending it.

- **Cookie:** `__Host-stryx_session` in production (forces `Secure`, `Path=/`, no `Domain`), `HttpOnly`, `Secure`, opaque 256-bit value, only its SHA-256 stored (unchanged). The name is configurable so plain-HTTP local development still works.
- **`SameSite=Lax`, not the `Strict` ADR-002 wrote.** With `Strict`, the browser withholds the cookie on the top-level redirect back from `discord.com`, and after a cross-site redirect the landing page can load looking signed out until a manual reload. `Lax` still blocks cross-site POSTs, which is the CSRF case. This is a deliberate deviation from ADR-002 and is called out in §8.
- **CSRF:** the API stays same-origin behind the dashboard's `/api` path (as the Vite proxy does now), no CORS plugin, no `Access-Control-Allow-Credentials`. On top: every non-GET request must carry an `Origin` (or `Sec-Fetch-Site: same-origin`) matching `APP_ORIGIN`, and only `application/json` bodies are parsed.
- **Lifetime:** users keep ADR-002's 7 days sliding, 30 days absolute. Session length does not affect scheduled mints, which fire from the stored `ownerId` in the job payload, so there is no automation reason to lengthen it. **Operator sessions:** 1 hour idle, 12 hours absolute (§4.10).
- **Session record:** `{userId, issuedAt, authWalletId, lastStepUpAt}`. No IP and no user agent (§4.13). `authWalletId` lets removing a sign-in wallet kill exactly the sessions it created.
- **Sign-out:** `DEL session:{hash}`, remove from `user_sessions:{userId}`, clear the cookie.
- **Sign out everywhere and revocation:** build the `user_sessions:{userId}` set ADR-002 promised (each entry expires with the session; stale members are trimmed on read). Triggers: user action, admin suspend, `user:{id}` emergency stop escalation, sign-in wallet removal (only that wallet's sessions), account deletion.
- **Step-up, the control that matters most here.** A session is not enough to move money. Actions that can drain or take over an account require a **fresh, action-bound signature**: the client asks `POST /auth/step-up {action, params}`, the server returns an EIP-712 typed-data payload (`StryxAction {action, paramsHash, nonce, expiresAt}`, a wallet screen that shows the amount and recipient), and the server verifies the signature against a sign-in wallet on the account. Required for: disperse from a bot wallet, deleting a bot wallet, adding or removing a sign-in wallet, changing or removing the email, deleting the account. Lower-risk sensitive actions (importing a wallet, unlinking Discord) need only a sign-in within the last 5 minutes (`lastStepUpAt`). Rationale: a stolen cookie, or a phished generic sign-in, must not be convertible into a withdrawal.
- **Legacy bearer path:** `Authorization: Bearer` keeps working for the operator token only (§4.10), and is no longer accepted for user sessions.

### 4.3 EIP-1271 smart-contract wallets: now or later

**Options.** (a) Support contract wallets at launch via `verifySiweMessage` with a public client. (b) EOA only at launch, with the schema ready for (a).

**Why not now, beyond effort:**

1. **The same address can be controlled by different parties on different chains.** For a smart account, "this address signed" is only meaningful on a specific chain (counterfactual and proxy-address squatting across chains is a documented failure mode). Account identity for contract wallets must therefore be `(address, chainId)`, whereas an EOA identity is chain-agnostic. That is a real modelling decision, not plumbing.
2. Verification makes an `eth_call` to a contract the *caller chose*, tying sign-in availability to that chain's RPC (there is no multi-provider failover today) and to attacker-supplied bytecode. ERC-6492 (undeployed wallets) adds a factory simulation on top.
3. A contract wallet's owner set can change after sign-in, so "who is signed in" can silently go stale, which pushes re-verification into step-up.

**Recommendation.** Later. At launch, `verify` accepts only signatures that `ecrecover` to the message address; anything else returns a short error ("Smart contract wallets are not supported yet"). Build the hook now: `sign_in_wallets` has `kind` (`EOA` | `CONTRACT`) and a nullable `chainId`, unique on `(lower(address), coalesce(chainId, 0))`, so adding contract wallets later is additive, not a migration. Revisit when WalletConnect ships (it will bring Safe users) and when the identity-key decision above has an owner.

Bot wallets are unaffected: they are always EOA keys that Stryx holds.

### 4.4 Identity versus owned wallets: the data model

**Recommendation.** Three separate concepts, three tables, no shared column.

- **`User`** is the account. It has no email and no password after cutover. It gains `displayName`, `avatarSource` (`GENERATED` | `DISCORD`), `avatarSeed` (the first sign-in address, fixed at creation so removing that wallet never changes the generated avatar), `termsVersion`, and a `DELETED` status for tombstones (§4.13).
- **`SignInWallet`** is a credential: `id, userId, address (unique, lowercase), kind, chainId?, label?, addedAt, lastUsedAt`. An account has 1 to 5. The last one cannot be removed. Identity resolution is always `address -> SignInWallet -> User`.
- **`Wallet`** (the existing bot wallet) stays exactly as it is, owned by `userId`, keys envelope-encrypted. It is an asset the account holds, never a credential. A bot wallet's key can never sign a user in, because sign-in requires a signature from a `SignInWallet`.

Decisions inside this:

- **A user may import a private key whose address is also one of their own sign-in wallets.** No constraint (each table stands alone), but the import screen shows a warning: this hands Stryx custody of the key that signs you in. That is the honest-custody framing ADR-002 §1 requires, applied to the one case where it matters most.
- **Address uniqueness on bot wallets stays global** (one key, one record, per the existing repository comment). The 409 on import reveals only "this address exists in Stryx", never whose. Accepted, and noted so nobody adds an owner to that message.
- **Sign-in wallet uniqueness is global.** A wallet already attached to any account cannot be linked to another, and the error is generic ("This wallet cannot be linked") so it does not confirm which accounts exist.
- **No account merging.** If a person signs in with wallet A and then, separately, with wallet B (two accounts), linking B into A's account fails. Merge is out of scope; it needs its own ADR because bot wallets and history would have to move.
- The reserved operator user (§4.10) gets its sign-in wallet by a script, so the operator's existing wallets stay under the same `userId`.
- `Wallet.userId`, the `@@index([userId, status])` and ADR-002 §3.3's structural `UserId` enforcement are untouched.

### 4.5 Account recovery

Custody raises the stakes: if a user loses every sign-in wallet, a *generated* bot wallet's funds are stranded (Stryx holds the only copy of the key). The design has to say what protects against that without creating a takeover path.

**Options.**

- **Email recovery.** Rejected: it makes the email inbox the real credential for custodial funds. That silently downgrades the account to the security of the user's mail provider and contradicts the decision that email is "for updates only".
- **Operator-assisted rebinding.** Rejected: nothing to verify a claimant against, a social-engineering magnet, and it hands a compromised operator account a takeover primitive.
- **Multiple sign-in wallets** (add a second wallet while signed in).
- **Time-delayed recovery wallet:** a pre-registered backup wallet whose sign-in starts a 72-hour cancellable countdown.
- **Export of generated keys** so users can self-recover. Not proposed: it reverses ADR-001's "the key never leaves" and needs its own decision (§8).

**Recommendation.**

- **No key export in v1 (confirmed, §8).** Acceptable only bundled with three things, all in scope for this ADR, not deferred:
  1. **Linking multiple sign-in wallets is the recovery mechanism.** Add flow: signed in, action-bound step-up from an existing wallet, plus a `link` challenge signed by the new wallet (proof of control). Max 5, no merging (§4.4). The UI nags (persistent banner) until an account that holds a bot wallet with a balance has a second sign-in wallet.
  2. **A sweep-funds action, available at any time, at the same step-up level as disperse from a bot wallet (§4.2).** `POST /me/wallets/:id/sweep {toAddress, chainId}` sends that bot wallet's full native balance (less gas) to an address the user controls, through the existing send path and audit log (it is a transfer, not a mint, so it stays out of `mint_events`, consistent with §4.12 stage 5's disperse-versus-mint split). `toAddress` cannot be another bot wallet on the same account by default, since that defeats the point, and needs an explicit override to allow. This is the practical antidote to "no export": a user who is nervous, or who has decided to leave, can always get funds out without needing Stryx.
  3. **A clear warning at sign-up and at first bot-wallet creation**, not buried in the terms: *"If you lose access to every wallet you sign in with, Stryx cannot recover this account or the funds in wallets it generated. Add a second sign-in wallet, and you can move funds out of any Stryx wallet at any time."*
  - **Key export is a follow-up (§6)**, not built here: it would need its own threat model (an exported key is a key Stryx can no longer vouch for the isolation of) and is not required once sweep exists.
- **Email plays no authentication or recovery role.** Its only job is updates. Storage and verification rules:
  - A `user_emails` row per user: `address` (lowercase), `verifiedAt`, `verifyTokenHash`, `verifyExpiresAt`. The verification token is single-use, 24 hours, stored hashed. The link opens a dashboard page that **POSTs** the token, because mail scanners prefetch GET links and would verify on the user's behalf.
  - Nothing is sent to an address before `verifiedAt` except the verification message. Uniqueness is enforced only among verified addresses (partial unique index), so an unverified claim cannot squat someone's email. Unverified rows are purged after 7 days.
  - Changing or removing needs action-bound step-up. If the old address was verified it is notified.
  - **This is the first outbound mail in the system. Provider: Amazon SES (confirmed, §8), since AWS is already provisioned for KMS.** Scope for this ADR, not a later integration detail:
    - **Domain verification:** SPF (`v=spf1 include:amazonses.com ~all`), DKIM (SES's own 3 CNAME records, easytype "Easy DKIM"), and a DMARC record (`p=quarantine` to start, `rua` pointed at an address the team reads) on the sending subdomain (`mail.stryx.example`, not the bare apex, so a sending-infra problem cannot affect the main domain's reputation).
    - **Sandbox:** SES starts in the sandbox (200 messages/day, verified recipients only). Verification-email volume at real signup rates will exceed that immediately, so leaving the sandbox (an AWS support request, needs a description of the use case and bounce-handling plan) is on the critical path before step 7 of the build order, not an afterthought.
    - **Bounce and complaint handling:** an SNS topic subscribed to SES bounce and complaint notifications, feeding a small handler that sets `verifiedAt = null` and suppresses further sends to that address (a hard bounce or any complaint) so the account's sending reputation cannot be dragged down by one bad address. A soft bounce is logged, not suppressed, until it recurs.
- v2, if demand shows up: the time-delayed backup wallet above.

### 4.6 Per-user custody: encryption and isolation

Today isolation between users is enforced by application logic only (the ownership-scoped repository and the branded `UserId`). At the cryptographic layer every wallet is wrapped under one CMK, so any code path that can call KMS Decrypt on the app's identity can unwrap any user's key, and a database attacker can copy user A's `wrappedDek` into user B's row without KMS noticing.

**Options.**

- **A. Single CMK, per-wallet DEK** (today). App-layer isolation only.
- **B. A plus KMS encryption context** bound to `{purpose, walletId, ownerId}` on every wrap and unwrap. KMS authenticates the context (it behaves as additional authenticated data), so a wrapped DEK moved to another row fails to unwrap, and CloudTrail records the context on every decrypt.
- **C. One CMK per user.** Real key-level isolation and a per-user kill switch, but it costs money per key per month, runs into per-region key quotas, and slows signup. It does **not** stop a compromised app: the app's single IAM role would still have Decrypt on all of them, unless the app assumed a per-user role per request, which is a large redesign.
- **D. A per-user key hierarchy** (user key wrapping wallet DEKs). Adds a layer without changing what an app compromise can reach.
- **E. Derive keys from the user's wallet signature.** Non-custodial, and the only option that truly isolates users, but the server could no longer sign unattended. Rejected: it removes the product's core capability (ADR-002 §1 already made this call).

**Recommendation.** **B now; C only on a stated trigger.**

- `wrapDek(dek, context)` and `unwrapDek(wrapped, context)` gain a context parameter, with `context = {purpose: 'wallet-dek', walletId, ownerId}`.
- **`ownerId` in the context comes from the authenticated caller** (`TransactionScope.ownerId`, which ADR-002 §3.7 already threads into the engine), not from the row being decrypted. So a caller who is not the owner presents the wrong context and the KMS call fails. This closes the gap ADR-002 records (the signing layer has no owner) with a cryptographic check, not a convention. `getKeyMaterialForSigning` gains an `ownerId` parameter.
- It is defence in depth, not a boundary against a full app compromise (an attacker running inside the app can supply any owner id). What it buys: cross-row DEK swaps fail, a wrong-owner code path fails closed, and every unwrap is attributable to a user in CloudTrail (alert on unusual per-user or per-wallet decrypt rates, as ADR-001 §3.3 intends).
- **Migration:** existing wrapped DEKs were produced without context, so they need a re-wrap. `WalletKeyService.migrateToProvider` and its batch script already do the same shape of operation with per-wallet isolation and optimistic concurrency. Add `wrapContextVersion` (0 = none, 1 = context) so both can coexist during the run and the unwrap picks the right form.
- **Triggers for revisiting per-user CMKs:** a contractual or regulatory per-tenant key requirement, a high-value user tier, or a decision to make per-user kill switches a first-class incident tool.
- Keep production and non-production CMKs separate, as ADR-002 §3.8 already requires.
- **Independent of this ADR but on its critical path:** the hard-coded `stryx_app_dev_only` password must be replaced at provisioning (`ALTER ROLE` in the deploy step), and the real-AWS `--commit` migration in `infra/aws/README.md` must have run.

### 4.7 Owner scoping: drops, schedules, disperse, mint history

Inventory, from the code (§2):

| Surface | Status | Action |
|---|---|---|
| Wallets, balances | Structurally scoped (`UserId` on every repository method). | None. |
| Mint, batch, preview, allow-list mint | `ownerId` flows to `getWalletSummary(ownerId, walletId)`. | None. |
| Disperse (source and walletId recipients) | Scoped. | None. |
| **Schedules: list, cancel** | **Not scoped.** | Fix (below). |
| **Allow-list store** | Global keys, in memory, no writer today. | Key by `(ownerId, allowListId)` before any HTTP writer exists. |
| Drops resolve, gas price, receipts | Public chain data, no ownership. | Per-user rate limit, since they spend the platform's OpenSea and RPC budget. |
| Mint history | Does not exist server-side. | New, born owner-scoped (§4.9). |

**Options for schedules.** (a) Filter `queue.getJobs()` by `job.data.request.ownerId` after fetching. Cheap, but `list()` reads only the first 100 jobs across all users, so at scale a user's own schedules fall off the end of someone else's list. (b) Make Postgres the source of truth for scheduled mints (a row per scheduled attempt) and use BullMQ purely as the timer.

**Recommendation.** (b). The `mint_events` row (§4.9) is created with `status = SCHEDULED` at scheduling time and its `id` is the BullMQ `jobId`. Listing and cancelling go through a `MintEventRepository` whose methods take `ownerId: UserId` first, exactly like `WalletRepository`. Cancel becomes "update where `id` and `ownerId`, then remove the job if the row matched"; a foreign id behaves as not found (404, never 403). This is the durable fix, and it also removes the 100-job cap and the 24-hour retention, which a quick patch cannot.

**The immediate leak is not waiting on this ADR.** It is being closed as a separate, small hotfix (an owner-index filter on `list()`, an ownership check on `cancel()`, and `SIGNUP_ENABLED` gating `/auth/signup`), planned and reviewed independently of the design here (not yet shipped as of this draft; tracked outside this document, not redesigned in it). Step 1 of the build order (§7) then migrates schedules onto `mint_events` for the fuller reasons above, once that leak is already closed by the hotfix, not to close it for the first time.

**Guard against regression.** A route inventory test: every registered route must declare a scope class (`public`, `user`, `admin`). An undeclared route fails the suite. A table-driven two-user contract test then runs, for every `user` route that takes an id, "user B gets 404 for user A's id". That turns "remember to scope the new endpoint" into a failing test.

### 4.8 Discord linking (OAuth2)

**Recommendation.**

- **Flow:** authorization code, scope `identify` only (no `email`, no `guilds`).
  1. `POST /me/discord/link` (session, `Origin` check, rate-limited to 5 per hour per user). The server creates `state` (256-bit random) and stores `discord:state:{sha256(state)} = {userId, sessionHash, codeVerifier?, createdAt}` with a 10-minute TTL, and returns the authorize URL. PKCE (`S256`) is added if Discord supports it for confidential clients (verify at build); `state` is the required control.
  2. `GET /auth/discord/callback?code&state` consumes the state with `GETDEL`. It must exist, and the request's session must resolve to the **same user and session** the state was bound to. That single check defeats the attack where someone starts the flow on their own account and tricks a victim into completing it (the state is bound to the attacker's session, so the victim's request is rejected). The callback does not rely on `SameSite` for this, which is why the `Lax` choice does not weaken it.
  3. Exchange the code server-side, call `GET /users/@me`, keep only `id`, `username` and the avatar hash, then **discard the tokens immediately** and revoke them at Discord's token revocation endpoint (best effort, verify the endpoint at build). Tokens are never written to Postgres, Redis or logs.
  4. Write `discord_links {userId (unique), discordUserId (unique), username, avatarHash, linkedAt}`. A Discord account links to at most one Stryx account.
  5. Redirect to a **fixed** dashboard path with a short status (`?discord=linked` or `?discord=failed`). No user-controlled redirect parameter, so there is no open redirect.
- **Redirect URI:** one exact HTTPS URL from configuration, registered in the Discord developer portal. No wildcards, no per-environment guessing.
- **Failure:** any Discord error leaves no partial state and returns a one-line message.
- **Avatar:** store the hash only, hotlink `cdn.discordapp.com` and allow it in the CSP `img-src`. Copying avatars into our storage would add retention and takedown obligations for little gain. When the user unlinks, the hash is deleted and no URL can be built.
- **Staleness is a consequence of "no tokens kept", and it is accepted.** The username and avatar are a snapshot from link time. A "Refresh from Discord" button re-runs the flow.
- **Unlink:** `DELETE /me/discord` hard-deletes the row (id, username, avatar hash) and, if the avatar source was Discord, reverts it to `GENERATED`. The audit entry records only `discord.unlink` with the user id, never a Discord field (§4.13).
- **Profiles are private.** Nothing in the product shows one user to another (no leaderboards, no social surface), so there is nothing to make visible. The user and the operator (§4.11, disclosed in §4.13) can see a profile. Any future public profile is an explicit opt-in flag defaulting to private, not designed here.
- **Display name:** not unique (there are no handles to squat and no enumeration), 1 to 32 characters after NFC normalisation, control and bidirectional-override characters stripped, always rendered as text. Discord usernames are shown with a "Discord" badge and never used as an identifier anywhere.

### 4.9 The mint event log: single source of truth

**Options.**

- **Extend the audit log.** Rejected: it is insert-only (good) and therefore cannot record `PENDING -> CONFIRMED` or gas after the fact, and it has no chain or contract columns.
- **Append-only transitions table plus a current-state view.** Faithful, and heavier than the read pattern (counts and sums of current state) needs.
- **One mutable row per attempt, with guarded transitions and column-level privileges.** Simple reads, and the immutable facts are protected at the database.

**Recommendation.** The third, in a new `mint_events` table (a sketch is in §5).

**Lifecycle.**

```
scheduled -> sending -> pending -> confirmed
     |          |          |-----> reverted   (mined, failed on-chain)
     |          |          '-----> dropped    (never mined, given up)
     |          '----------------> blocked    (never sent: simulation, eligibility, stop, cap, RPC...)
     |-> cancelled
     '-> rescheduled  (auto-schedule handed over to a new event)
```

An immediate mint is inserted directly as `sending`. The four states in the brief map to the UI as: **pending** = `sending` + `pending`, **confirmed**, **reverted on-chain** = `reverted` (plus `dropped`, shown as "never mined"), **blocked before sending** = `blocked`. `scheduled`, `cancelled` and `rescheduled` are lifecycle states that feed the Operations cards and are **excluded from every outcome statistic**.

**Fields.** `id` (also the BullMQ `jobId`), `ownerId`, `walletId` and a snapshot `walletAddress`, `chainId`, `contractAddress`, `kind` (public or allow-list), `quantity`, `source` (`MANUAL` | `SCHEDULED` | `API`), `status`, `failureReason` (a short code from `MintFailureReason`, never raw error text), `txHash`, `nonce`, `blockNumber`, `gasUsed`, `effectiveGasPriceWei`, `feeWei`, `l1FeeWei?`, `valueWei` (mint price paid), `scheduledFor`, `createdAt`, `broadcastAt`, `settledAt`, `rescheduledToId?`. Wei is `NUMERIC(78,0)`, not a string (ADR-002 stored wei as strings, but analytics needs `SUM` in SQL, and a JS number cannot hold wei). The collection name is **not** stored per event: a small `collections(chainId, contract, name, slug, updatedAt)` lookup is joined at read time, so names improve retroactively and stay null on testnets, as today.

**`source`.** `MANUAL` = a dashboard-session HTTP request, `SCHEDULED` = fired by the worker, `API` = any request authenticated by a non-session bearer credential (today the operator token, later per-user API keys if they exist). Until the operator dashboard moves to SIWE (build step 4), its mints authenticate with the token and would record as `API`; that is a known, temporary mislabel affecting only the operator's own manual-versus-API split.

**One writer, at the one choke point.** A `MintEventRecorder` is called from `MintExecutionService`, which both HTTP controllers and the scheduler already go through. `source` is a field of the request (`PublicMintRequest.source`, set by the caller from the auth method and the entry point, never from the body). Because everything funnels through one service, "every route that can mint writes an event" is checkable by a test that enumerates the callers.

**Write-ahead and failure policy.**

- The row is inserted **before signing**. If that insert fails, the mint aborts with a 503: an unrecorded mint is exactly what "single source of truth" forbids. (This differs from the audit log, which never throws; the difference is deliberate.)
- The hash is computable once the transaction is signed and before it is sent. A small `onSigned(hash, nonce)` hook in the engine (the only engine change in this ADR) lets the recorder persist `txHash` and move to `pending` **before** `sendRawTransaction`. That fixes the caveat recorded in `CONTEXT.md` (a send timeout was classified "blocked before sending" although the transaction might have been broadcast): a row with a hash is never `blocked`; it stays `pending` and the reconciler decides.
- Updates after broadcast are best effort and loud on failure. The row stays `pending` with its hash and the reconciler repairs it from the chain.
- A row left in `sending` with no hash after a crash is moved to `blocked` (`failureReason = interrupted`) by the reconciler after a grace period.

**Reconciler.** A BullMQ repeatable job (the project's existing queue) every 15 to 30 seconds. It reads `pending` rows in batches per chain, fetches receipts, and writes status, `blockNumber`, `gasUsed` and `effectiveGasPriceWei`. A row with no receipt after a configurable window (proposed: 6 hours) becomes `dropped`, and is re-checked once a day for a week in case it lands late. This replaces dashboard-side receipt polling for history (the receipts route stays for Disperse). It depends on per-chain RPC health, and there is still no multi-provider failover; a chain outage delays settlement, it does not corrupt anything.

**Gas caveats.** `feeWei = gasUsed x effectiveGasPrice` is the L2 execution fee. As I understand it, OP-stack chains add a separate L1 data fee (an `l1Fee` field on the receipt) while Arbitrum folds it into `gasUsed`, so `l1FeeWei` is recorded where the receipt has it and treated as best effort. Verify per chain at build. Blocked mints burn zero gas by definition. Gas is stored in each chain's native token and **never summed across chains** (§4.11).

**Immutability, enforced by Postgres, not by convention.** `stryx_app` gets `INSERT` and `SELECT` on `mint_events`, **no `DELETE`**, and `UPDATE` only on an explicit column list (status, failure reason, hash, nonce, block, gas and fee columns, `settledAt`, `rescheduledToId`). The identity columns (owner, wallet, chain, contract, source, kind, quantity) cannot be changed by the app role. A trigger additionally rejects illegal status transitions (a `confirmed` row never becomes `blocked`). This works because `stryx_app` does not own the table (the finding recorded in `CONTEXT.md` Gotcha 7).

Postgres detail that matters: a table-level `UPDATE` grant cannot be narrowed by a column-level `REVOKE`. The pattern is to revoke table-level `UPDATE` and grant column-level `UPDATE` on the allow-list. New columns are then read-only to the app until someone grants them, which fails safe.

**A test proves this, not just the migration SQL.** Same shape as the audit-log test this project already has (`CONTEXT.md` Gotcha 7 records why: a table's owner bypasses its own `REVOKE`, so the grant has to be checked against the real `stryx_app` connection, not asserted from the migration file). The test connects as `stryx_app` against a real database and asserts: `DELETE FROM mint_events` fails, `UPDATE mint_events SET "ownerId" = ...` fails, and `UPDATE mint_events SET status = ...` on an allowed column succeeds. It runs in the same suite as the migration, so it fails the build the moment the privilege grant regresses, not months later when it matters.

**Fix the default privileges in the same migration.** `provision_app_role` set `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stryx_app`, so every new table starts fully writable and deletable. Change the default to `SELECT, INSERT` and make each migration state its extra grants explicitly. That default is the reason the audit-log protection needed manual care, and it would silently defeat the protections above for the next table.

**Relationship to the audit log.** The audit log stays the insert-only who-did-what security record, and `mint.*` entries continue. The mint log is the what-happened record and owns status, gas and history. They are written independently and answer different questions. Scheduled mints, which are audited nowhere today, get an audit entry at fire time as a side effect of this work.

### 4.10 Roles: operator and admin

**Options for enforcement.** (a) Keep `requireAdmin` called by hand in each admin handler (today). (b) Put every admin route in one Fastify plugin under `/admin` whose `onRequest` hook enforces the role, and fail the boot if a route is registered under `/admin` outside it.

**Options for designation.** (a) An env allow-list of operator addresses evaluated at sign-in. (b) A `role` column set by a privileged database action only.

**Recommendation.**

- **Structural enforcement.** (b) for routes: the admin plugin, plus the §4.7 route inventory test (`admin` scope class), so a new admin route cannot be added without the guard. The guard reads the role **from the database on every request**, never from the session or a cookie, so demotion is immediate. Admin traffic is small; one indexed read is free.
- **Designation by database privilege.** (b) for roles. `stryx_app` loses table-level `UPDATE` on `users` and gets column-level `UPDATE` only on columns it legitimately changes (status, profile fields, spend cap fields, `updatedAt`), **not `role`**. Then a compromised app, or an SQL bug, cannot promote any account to `ADMIN`. Promotion is a CLI script (`operator:grant <address>`) run with the migration role (`DATABASE_URL`), which also writes a `role.grant` row to the audit log with `actorType = SYSTEM`. A wallet-address env allow-list was rejected: it makes environment configuration equal to admin, and it evaluates only at sign-in.
- **The operator's existing data.** The reserved operator user already owns the existing wallets. A second script (`operator:adopt <address>`) attaches the operator's real sign-in wallet to that reserved user, so signing in with it lands on the same `userId` with its wallets, not on a fresh account.
- **Protecting the account.**
  - At least two operator wallets, so losing one is not a lockout.
  - Admin sessions 1 hour idle, 12 hours absolute.
  - Action-bound step-up (§4.2) for: any emergency-stop action, suspend or unsuspend, and any drill-down into user-level records or export. Aggregates need only an admin session.
  - **Every admin read of user-level data is audit-logged** (`admin.view_user`, `admin.view_mint_events` with a filter summary), not just writes. This is the insider-risk control ADR-002 §2.8 asks for, extended to reads.
  - **No ownership bypass, unchanged from ADR-002 §3.5.** The admin surface cannot mint, disperse or sign from a user's wallet, and has no access to key material. Analytics runs through a separate read-only repository (below).
  - **Network-restricted from v1 (confirmed, §8), not deferred to "before external users."** `/admin` is served only behind an identity-aware access proxy (Cloudflare Access or Tailscale; pick at build based on what the team already runs) that authenticates the operator's own identity before the request reaches the app. An IP allow-list was considered and rejected: it protects a network location, not a person, and residential and mobile IPs are not stable enough to be useful here anyway.
- **Ceiling of an operator-account compromise, stated explicitly.** Read platform analytics and user-level records, trigger emergency stops, suspend users. **Not** move or sign funds, not read keys, not promote itself. (An attacker with infrastructure or AWS access is a different actor, covered by ADR-001 and ADR-002 §2.8.)
- **The shared `API_AUTH_TOKEN`.** It is a static, non-expiring, unattributable secret that currently grants full ADMIN. Recommendation: after SIWE cutover it still authenticates as the reserved operator user for programmatic use (`source = API`) but **loses ADMIN**: `requireAdmin` requires a session-authenticated request (`authMethod = 'session'`). In production the token is disabled unless explicitly enabled; local development keeps it. `CONTEXT.md`'s "log in with `API_AUTH_TOKEN`" instruction remains true for development only.

### 4.11 Operator analytics (24h, 7d, 1m)

**Definitions come first**, because a dashboard number is only as good as its definition. Where these differ from the existing per-device panel, the difference is intentional and noted.

- **Windows:** 24 hours, 7 days and 30 days, rolling, bucketed hourly (24h) or daily (7d and 1m). Buckets are UTC so two operators see the same chart (the current panel buckets in local time, which is right for one person and wrong for a shared number). An optional `tz` parameter is reserved.
- **Users:** *total* (accounts, excluding `DELETED`), *new* (`createdAt` in window), *signed in* (distinct users with a sign-in in the window, from the audit log), *active* (signed in **or** created a mint event in the window), and *activated* (has created a bot wallet, or has a mint event). **Users are wallets that signed, not people.** Account creation is free, so *total* and *new* can be inflated by one person with many wallets. *Activated* is the honest funnel number and should sit beside them.
- **Mints:** "a mint" is a settled attempt, as in the current panel: `confirmed + reverted + blocked + dropped`. `pending` is counted separately ("and 3 still pending"), and `scheduled`, `cancelled`, `rescheduled` are never counted. **Success rate** = `confirmed / (confirmed + reverted + blocked + dropped)`. With nothing settled, show "No mints in this period", never 0%.
- **Failure split.** The brief's on-chain versus before-sending split is kept (`reverted`+`dropped` versus `blocked`). One addition: a single failure rate hides that "blocked" mixes very different things. `failureReason` maps to a `failureClass`:
  - **USER:** `not_eligible`, `no_active_public_stage`, `insufficient_funds`, `allowlist_not_found`, `no_fee_recipient_configured`
  - **POLICY:** `emergency_stop`, `spending_cap_exceeded`
  - **INFRA:** `rpc_unavailable`, `opensea_fetch_failed`, `unsupported_chain`, `interrupted`
  - **CHAIN:** `simulation_reverted` and on-chain reverts

  The operator views success rate overall and with USER and POLICY excluded (the number that reflects platform health).
- **Breakdowns:** by chain, by collection (chain plus contract, named via the `collections` lookup), and by source (manual, scheduled, API).
- **Gas:** total fee, mean and median per mint (settled rows with receipts), and **burned on failures** (`sum(feeWei) where status = reverted`). **Per gas token, never across chains**: a sum of ETH, POL and testnet ETH is meaningless without a price feed, and a USD figure is a follow-up (§6). Rows still awaiting a receipt are counted as "gas pending", not treated as zero.
- **Top collections** (by mints and by distinct users) and **top users** (by mints and by gas).
- **Drill-down:** every number links to the filtered list of underlying `mint_events` (cursor-paginated, with explorer links). A user view shows profile, sign-in wallets (addresses), bot wallets (address, tier, origin, never key columns) and their events. Each drill-down is audit-logged (§4.10).
- **Coverage honesty, kept from the current panel.** The response carries `dataStartsAt` (the earliest event). Buckets before it are "unknown" (the existing dotted slot), never zero. For every account created after the cutover there are no unknown slots, which is what retires "Not recorded on this device" (§4.12).

**Endpoints (all under `/admin`, all behind the §4.10 guard).** `GET /admin/analytics/summary?window=`, `/timeseries`, `/breakdown?by=chain|collection|source|reason`, `/top?kind=collections|users`, `/events?...&cursor=`, `/users/:id`. Responses carry `asOf`. A 30 to 60 second Redis cache is enough.

**Implementation.** SQL aggregates (`date_trunc`, `count(*) filter (where ...)`) through `$queryRaw` over indexes on `(createdAt)`, `(status, createdAt)`, `(chainId, createdAt)` and `(chainId, contractAddress, createdAt)`. Add hourly rollups only when a real query is slow; propose 1 million rows as the point to look, not before. The queries run through a **separate read-only role** (`stryx_analytics`): `SELECT` on `mint_events`, `collections`, `audit_log` and `users`, and **column-level `SELECT` on `wallets` that excludes `encryptedPrivateKey`, `wrappedDek`, `iv` and `authTag`**. A bug in an analytics query cannot write, and cannot read key material.

**One implementation for users and the operator.** The per-user feed, chart and boxes and the operator analytics are the same aggregate queries with a different scope: `MintStatsRepository.summary(scope)`, where `scope` is `{ownerId: UserId}` or a platform scope constructible only from the admin guard's `AdminContext` type. A user route cannot ask for platform scope because it cannot obtain the type. This is ADR-002 §3.3's branded-id idea applied to reads.

**UI.** Reuses the existing Operations components and the BRAND.md "Mint outcomes chart and stat boxes" rules (tokens only, ✓ and ✕ glyphs, failed hatched, the accessible plot). No new colours. The operator page is a new route behind the admin guard.

### 4.12 Migration: feed, chart, stat boxes, Disperse user mode

Each stage ships independently and is reversible until the last.

1. **Dark launch.** Build the log and recorder (§4.9) while the dashboard still reads `localStorage`. Add a reconciliation check: every device-recorded row that has a hash must have a server row. A mismatch means the recorder missed a path.
2. **Server reads.** Add `GET /me/mints`, `/me/mints/summary` (same definitions as §4.11, owner scope). Switch the feed, chart and boxes to them behind a flag. `localStorage` becomes a cosmetic cache only. `chargeLogo` bookkeeping (`charged` hashes) stays client-side because it is UI state, not data. Confirmation is observed by polling `GET /me/mints?since=`.
3. **Retire the label.** "This device" goes away when three things are true together: (i) a test proves every caller of `MintExecutionService` writes an event (manual, scheduled, API), (ii) the feed reads server rows, (iii) the reconciler is settling statuses without a dashboard open. Then "Showing mints from this device + scheduled jobs" becomes "All your mints since {dataStartsAt}", and the "Not recorded on this device" slots and the "a job that ran while the dashboard was closed can never be recovered" note are deleted.
4. **Existing device history: clean start, not imported (confirmed, §8).** The rows in `localStorage` are client-supplied, so importing them would put unverified data in the source of truth and let anyone inflate operator analytics; verifying is only possible for rows with a hash, and blocked or scheduled rows cannot be verified at all. There are no real users, and the operator's history is testnet, so on first load after cutover the dashboard **exports `stryx-mint-feed-v1` to a timestamped JSON archive file** (a manual download, or written to a fixed path if run from a script; the operator keeps it if they want the testnet record for their own reference), then deletes the `localStorage` key and shows history from the cutover. The archive is never imported into `mint_events`, and nothing reads it back. `stryx-theme` and `stryx-sidebar-pinned` are untouched.
5. **Disperse.** The `mode` prop (`operator` or `user`) disappears. The "our wallets" choices were withheld from `user` mode only because users could not own wallets. Once accounts exist, the Disperse page shows what `GET /wallets` returns for the caller (owner-scoped) plus the connected-wallet path, for everyone. The operator is simply a user with more wallets. The connected-wallet flow (browser signs, Stryx never sees a key) is unchanged, and can reuse the wallet already connected at sign-in. Disperse from bot wallets now requires the action-bound step-up (§4.2). Disperse is not a mint, so it stays in the audit log only and out of mint analytics; a generalised transaction log is a follow-up if analytics wants it (§6).
6. **Operator sign-in.** Ship SIWE alongside the existing token login, run `operator:adopt`, then remove the token login from production builds (§4.10).
7. **Old auth.** No real users exist, so `users.email` and `passwordHash` can be dropped in the same expand and contract sequence: add the new tables, make the two columns nullable, cut over, then drop them and `POST /auth/signup` and `/auth/login`. Test accounts from live verification are deleted.

### 4.13 Privacy: what the operator sees, retention, notice wording

The following are engineering defaults. **The notice, terms and retention periods are drafts pending legal review before any external user signs up; nothing below is legal advice, and none of it should be treated as final.** Two regimes are named because they are the ones already in view, not because the analysis is done: the Nigeria Data Protection Act 2023 (the likely home jurisdiction, pending business registration) and GDPR (if EU users are accepted, which is not yet decided). I have used GDPR-style defaults in the design below (minimisation, purpose limitation, a right to export and delete) because they are the stricter baseline, cheap to build now and expensive to retrofit, and they are not known to conflict with the NDPR's requirements, but that has not been confirmed by counsel. Jurisdiction for the terms themselves is to be confirmed once the business registration is settled.

**What is collected, and who sees it**

| Data | Purpose | Operator sees | Kept |
|---|---|---|---|
| Sign-in wallet addresses | Identity | Yes (analytics, drill-down) | Life of account |
| Signed terms acceptance (version, time, message hash, signature) | Evidence of consent | Yes, on user detail | Life of account, then version, time and hash only for 24 months |
| Bot wallet addresses, tier, origin, live balance | The product | Yes, on user detail | Life of account |
| Mint events | The product, analytics | Yes | Life of account, then anonymised (below) |
| Display name, avatar source | Profile | Yes | Life of account |
| Discord id, username, avatar hash | Profile | Username only, on user detail | Until unlinked, or account deletion |
| Email address | Updates only | **Masked** (`a***@d***.com`) plus verified flag. Only the mail sender reads it. | Until removed, or account deletion. Unverified: 7 days. |
| Private keys | Signing | **Never** (no endpoint, envelope-encrypted) | Life of wallet |
| IP address, user agent | none | **Not stored** in Postgres or in session records. Rate limiting uses Redis keys with a hashed IP and a short TTL. Proxy access logs, if any, are kept 14 days. | n/a |

**Retention and deletion**

- **Mint events:** kept for the life of the account (they are the user's own history). On account deletion they are **anonymised, not deleted**: `ownerId` is repointed to the account's tombstone, `walletId` and `walletAddress` are nulled, and chain, contract, status, gas and timestamps remain, so aggregate statistics survive and nothing identifies a person.
- **Account deletion** (`DELETE /me`, action-bound step-up, refused while any bot wallet holds funds, reusing the existing delete guard so custodial funds are never stranded): the `users` row becomes a tombstone (`status = DELETED`, every attribute nulled, id kept so foreign keys stay valid), sign-in wallets, Discord link, email and profile are hard-deleted, sessions revoked, and any scheduled events cancelled.
- **Audit log:** append-only for the app role, so the app **cannot** honour a deletion request against it. Two rules follow. (1) **`audit_log.detail` and the event-bus payload must never contain personal data** beyond user and wallet ids: no Discord username, no email, no display name, no IP. Ids alone are pseudonymous. Add a test that scans audit call sites. (2) Retention is 24 months by monthly partition, dropped by a maintenance job that runs as the owner role and is itself logged.
- **Discord unlink** hard-deletes immediately. There is no token to revoke afterwards (§4.8).
- **Export:** `GET /me/export` returns the user's own profile, wallets (no keys) and mint history as JSON or CSV. It doubles as a dashboard feature.
- **Operator access is logged** (§4.10), and disclosed in the notice.

**Notice wording, draft, not legal advice.**

*Custody (must appear where a wallet is created, not only in the terms; from ADR-002 §1):* "Stryx generates and encrypts your bot wallet's private key. We never see it in plaintext during normal operation, and no single system component can extract it, but Stryx's infrastructure holds your key material so scheduled mints can run while you are away. This is different from a self-custody wallet such as MetaMask, where only you hold the key. If you lose access to every wallet you sign in with, we cannot recover this account or the funds in wallets we generated."

*Privacy summary:* "You sign in with a wallet. We store the wallet address, the bot wallets you create with us, and a record of every mint (chain, contract, status, gas, time). Optionally you can add a display name, an email for product updates, and a linked Discord profile (id, username, avatar only). Stryx staff can see this information across all users for running and improving the service, and each time they look at an individual's records it is logged. We do not store your IP address or device details. You can unlink Discord or remove your email at any time, download your data, and delete your account once your wallets are empty."

### 4.14 Threat model

| Threat | Vector | Controls | Residual |
|---|---|---|---|
| **Replay** of a sign-in | Captured SIWE message and signature | Single-use nonce (atomic `GETDEL`, burned even on failure), 5-minute expiry, server-built message checked field by field, domain and URI pinned to config, session minted fresh on every sign-in | None known for sign-in. A replayed *session cookie* is session theft, below. |
| **Phishing** (relay) | A lookalike site fetches a real challenge, has the user sign it, submits it to the real API | Wallets warn on domain mismatch (client-side, not enforceable by us), 5-minute expiry, no IP or client binding possible without breaking mobile. **Consequence is contained by design:** a phished sign-in yields a session, and a session cannot move money because drain-class actions need an action-bound signature that shows amount and recipient (§4.2). Daily spend caps (ADR-002 §3.7) bound the rest. | A user can still be tricked into signing an action-bound message they do not read. A phished sign-in can read that account's data. Mitigated by a verified-email or Discord alert on drain-class actions (follow-up), user education, and a single canonical domain. |
| **Session theft** | XSS, malware, a leaked cookie | httpOnly cookie, `__Host-` prefix, strict CSP (`script-src 'self'`, Discord CDN in `img-src` only), TLS and HSTS, `Origin` check, absolute lifetime, sign-out everywhere, action-bound step-up for money movement | XSS can still act inside the page as the user for non-step-up actions. CSP and the absence of user-supplied HTML (display names are text) are the defence. |
| **Discord account takeover** | Attacker controls a linked Discord account | Discord is never a sign-in method, so it cannot open a Stryx account. Linking needs a live Stryx session and a state bound to that session, tokens are discarded, the profile is display-only and private | None for access or funds. **Becomes relevant when Discord roles gate allow-list eligibility** (§6), and that follow-up needs its own review. |
| **Cross-user data access** | A missing owner filter on a route | Structural `UserId` on every repository (wallets today, `mint_events` and schedules by §4.7), 404 never 403, KMS encryption context bound to the caller's owner (§4.6), route inventory test, two-user contract test, allow-lists keyed by owner | A new repository written without the pattern. The inventory test is the backstop. |
| **Operator account compromise** | Stolen or phished operator wallet, or a stolen operator session | Role changeable only by the migration role, so no self-promotion. Admin plugin guard with a per-request DB role read. Step-up on emergency stop, suspend and user-level reads. Short admin sessions. Multiple operator wallets. Reads audit-logged. No ownership bypass and no key access on the admin surface. `/admin` behind an identity-aware access proxy from v1 (§4.10) | Ceiling is: read all platform data, stop or suspend accounts. Cannot move funds, sign, read keys or promote itself. Read access to all users' history is still a serious privacy incident, which is why the audit trail and step-up exist. An access-proxy account compromise is a separate incident, covered by that proxy's own security, not this ADR. |
| **Wallet-linking hijack** | An attacker with a stolen session adds their own wallet to the account | Adding needs an action-bound signature from an existing wallet and a proof-of-control signature from the new one. Removal is likewise step-up, and revokes that wallet's sessions | A phished action-bound signature. A cooldown before a newly added wallet can remove others was considered and deferred. |
| **Sybil and abuse** | Free account creation per wallet | Rate limits on challenge and verify, accounts hold no funds, the *activated* metric separates real use from noise (§4.11), per-user rate limits on the shared OpenSea and RPC budget | Inflated "total users" and "new users" (documented as wallets, not people). |
| **Smart-contract wallet abuse** | Attacker-chosen `isValidSignature` contract | Deferred (§4.3) | n/a until built. |
| **Audit or log tampering** | Compromised app tries to hide its actions | Audit log insert-only for the app role (existing). `mint_events` identity columns immutable to the app role, no `DELETE`. Default privileges fixed (§4.9) | A database owner-role compromise, out of scope per ADR-001. |
| **Analytics leaks key material** | An analytics bug or over-broad query | Separate read-only role, column-level `SELECT` on `wallets` excluding key columns | None known. |
| **Funds stranded with no path out** | A user loses every sign-in wallet, or simply wants their funds out before trusting the account further | Sweep-funds action (§4.5), usable at any time with no dependency on account trust or recovery having gone right | None once swept. Before sweeping, the same "no recovery" residual as account access, above. |

### 4.15 Migration of existing password accounts

**State of the world (verified against code, §2):** there are no real user accounts today. `signup`/`login` are open but unused by anyone but the operator and this project's own live-verification test accounts. So this section is mostly a policy for a case that, as of this ADR, does not exist yet, plus the operator's own path, which does.

- **Any password account that exists at cutover** (none expected, but the mechanism must exist so cutover is not a surprise): on their next login with the old password flow, they land on a mandatory "link a sign-in wallet to continue" screen. The password authenticates that one session; the wallet-link step then runs the same proof-of-control flow as §4.5 (sign a `link` challenge), and the account converts. There is no path that lets a password alone satisfy sign-in after this: it is a one-time bridge, not a parallel login method.
- **The operator's account** goes through this same bridge deliberately, via the `operator:adopt` script (§4.10), so it lands on the existing reserved `userId` rather than a fresh account.
- **Password login is retired at build step 3 (§7), for the operator, alongside the SIWE launch,** not held open "in case." The live-verification test accounts created during this project's own testing are deleted, not migrated: they are not real usage. `users.email` and `passwordHash` are dropped in the expand/contract sequence §4.12 stage 7 already describes (nullable first, then dropped once nothing depends on them), and `POST /auth/signup` and `/auth/login` are removed from the router, not just gated, once that is true.
- **The `SIGNUP_ENABLED` flag from the separate hotfix (§4.7) is superseded, not layered on top:** once `/auth/signup` and `/auth/login` are removed, the flag that gates them has nothing left to gate and is deleted in the same change.

## 5. Data model sketch (not final; the design intent, not a migration)

```prisma
model User {
  id             String      @id @default(uuid())
  role           UserRole    @default(USER)          // only the migration role may UPDATE this column
  status         UserStatus  @default(ACTIVE)        // ACTIVE | SUSPENDED | DELETED
  displayName    String?
  avatarSource   AvatarSource @default(GENERATED)    // GENERATED | DISCORD
  avatarSeed     String                              // first sign-in address, fixed at creation
  termsVersion   String
  createdAt      DateTime    @default(now())
  updatedAt      DateTime    @updatedAt
  // existing: dailySpendCapWei, spendCapEnabled, wallets
  // dropped after cutover: email, passwordHash
  signInWallets  SignInWallet[]
  discordLink    DiscordLink?
  email          UserEmail?
  @@map("users")
}

model SignInWallet {
  id         String    @id @default(uuid())
  userId     String
  address    String                                   // lowercase
  kind       SignInKind @default(EOA)                 // EOA | CONTRACT (CONTRACT unused in v1)
  chainId    Int?                                     // only for CONTRACT
  label      String?
  addedAt    DateTime  @default(now())
  lastUsedAt DateTime?
  @@unique([address])                                 // becomes (address, coalesce(chainId,0)) when CONTRACT ships
  @@index([userId])
  @@map("sign_in_wallets")
}

model TermsAcceptance {
  id          String   @id @default(uuid())
  userId      String
  version     String
  acceptedAt  DateTime @default(now())
  messageHash String
  message     String?                                 // full SIWE message, dropped on deletion
  signature   String?
  @@index([userId, version])
  @@map("terms_acceptances")
}

model DiscordLink {
  userId        String   @id
  discordUserId String   @unique
  username      String
  avatarHash    String?
  linkedAt      DateTime @default(now())
  @@map("discord_links")
}

model UserEmail {
  id              String    @id @default(uuid())
  userId          String    @unique
  address         String                              // lowercase; unique among verified only (partial index)
  verifiedAt      DateTime?
  verifyTokenHash String?
  verifyExpiresAt DateTime?
  createdAt       DateTime  @default(now())
  @@map("user_emails")
}

model MintEvent {                                     // table: mint_events
  id                   String     @id @default(uuid()) // also the BullMQ jobId
  ownerId              String                          // FK users.id, required
  walletId             String?                         // nulled on deletion anonymisation
  walletAddress        String?                         // snapshot, nulled on deletion anonymisation
  chainId              Int
  contractAddress      String
  kind                 MintKind                        // PUBLIC | ALLOWLIST
  quantity             Int
  source               MintSource                      // MANUAL | SCHEDULED | API
  status               MintStatus                      // SCHEDULED SENDING PENDING CONFIRMED REVERTED DROPPED BLOCKED CANCELLED RESCHEDULED
  failureReason        String?                         // short code, never raw error text
  txHash               String?
  nonce                Int?
  blockNumber          BigInt?
  gasUsed              Decimal?   @db.Decimal(78, 0)
  effectiveGasPriceWei Decimal?   @db.Decimal(78, 0)
  feeWei               Decimal?   @db.Decimal(78, 0)
  l1FeeWei             Decimal?   @db.Decimal(78, 0)
  valueWei             Decimal?   @db.Decimal(78, 0)
  scheduledFor         DateTime?
  createdAt            DateTime   @default(now())
  broadcastAt          DateTime?
  settledAt            DateTime?
  rescheduledToId      String?
  @@index([ownerId, createdAt])
  @@index([status, createdAt])
  @@index([chainId, createdAt])
  @@index([chainId, contractAddress, createdAt])
  @@index([createdAt])
  @@map("mint_events")
}

model Collection {                                    // table: collections (name lookup, joined at read time)
  chainId   Int
  contract  String
  name      String?
  slug      String?
  updatedAt DateTime @updatedAt
  @@id([chainId, contract])
  @@map("collections")
}

// Wallet: add wrapContextVersion Int @default(0)  (§4.6)
// Redis: siwe:nonce:{hash}, session:{hash}, user_sessions:{userId}, discord:state:{hash}
```

## 6. Follow-ups (noted, not designed)

- **Discord role checks for allow-list eligibility.** Worth knowing now: the identify-only, no-token model still supports this if a Stryx bot is added to the relevant guild. The bot can read a member's roles using only the stored Discord user id, so no user token needs to be kept. This will also change the takeover analysis in §4.14 and needs its own review.
- **WalletConnect for mobile users outside wallet browsers.** Also the point at which contract-wallet users arrive (§4.3).
- **Disperse contract deployment on chains without one** (Robinhood Chain and its testnet are `null` today).
- Also flagged while writing this, not part of the brief: a USD price feed for cross-chain gas totals; a generalised transaction log if analytics should include Disperse; per-user API keys (the `API` source is reserved for them); a per-wallet spend sub-limit (the gap ADR-002 §3.7 already records); an out-of-band notification (email or Discord) on drain-class actions.

## 7. Proposed build order (after approval)

Each step is verified against real Postgres and Redis, not only test fakes, as the ADR-002 steps were, and each ships behind tests that fail against the old behaviour.

**The open signup and unscoped schedule list/cancel (§2) are closed by a separate hotfix**, planned ahead of and independent of this build order (§4.7), not by anything below. Until that hotfix ships, the API is not safe to expose to untrusted callers; nothing in this build order is a substitute for it.

1. **The mint event log.** `mint_events` and `collections`, the privilege changes (default privileges to `SELECT, INSERT`, column-level `UPDATE`, no `DELETE`), the `MintEventRecorder` at `MintExecutionService`, the `onSigned` hook in the engine, the reconciler, and the status-transition trigger. Move schedule list and cancel onto the owner-scoped repository (closing the leak, the 100-job cap and the 24-hour window), audit scheduled mints, add `GET /me/mints` and `/me/mints/summary`. Dark-launch beside `localStorage` with the reconciliation check (§4.12 stage 1).
2. **Dashboard reads the server.** Feed, chart and stat boxes on the server data, retire "this device", delete the old store (§4.12 stages 2 to 4). Depends only on step 1, not on identity.
3. **Identity core.** SIWE challenge and verify, `sign_in_wallets`, `terms_acceptances`, cookie sessions, the `user_sessions` index, `Origin` check, rate limiting, the sign-in page (full lockup per BRAND.md), the route inventory test and two-user contract test, the admin plugin, `role` column privilege change, and the `operator:grant` and `operator:adopt` scripts. Expand step of the `users` migration.
4. **Operator on SIWE, then analytics.** Operator signs in with a wallet, the legacy token loses ADMIN, then `/admin/analytics/*`, the read-only role and the analytics page (§4.10, §4.11).
5. **Step-up and multi-wallet.** Action-bound EIP-712 step-up, link and unlink sign-in wallets, the recovery banner. Disperse from a bot wallet moves onto step-up.
6. **Profile and Discord.** Display name, generated avatar, then the OAuth flow.
7. **Email.** Provider decision, verification flow, masked display. Needs the SES (or equivalent) integration first.
8. **User dashboard.** Mount the user routes, terms and privacy pages, retire the Disperse `mode` prop, contract step of the `users` migration (drop `email`, `passwordHash`, and the old routes).
9. **KMS encryption context and owner-bound unwrap**, with the fleet re-wrap. Independent of steps 2 to 8 and can run in parallel, but it is a **launch gate**: nothing holding a real user's funds ships without it and the ADR-002 §3.8 AWS items.
10. **Later:** EIP-1271 (§4.3), delayed recovery wallet (§4.5), the §6 items.

**Launch gate before any external user,** on top of the above: real KMS cutover complete, `stryx_app` password rotated, retention job in place, notice and terms reviewed by counsel. (`/admin`'s network restriction is not a launch-gate item: it is required from v1, §4.10.)

## 8. Decisions

The eight questions this draft originally raised, and how they were resolved. Each answer is already folded into its §4.x section above; this is the record of the decision, not a live open list.

1. **Numbering: ADR-003, superseding ADR-002's password-auth sections only.** ADR-002 stays as the record of what shipped (custody, structural ownership, roles, the parts unrelated to how a user authenticates); its superseded passages are marked in place, original text kept. Nothing here revises ADR-002 by rewriting it.
2. **`SameSite=Lax`, not ADR-002's `Strict`.** Accepted, on condition every state-changing (non-`GET`) request is also protected by the `Origin`/`Sec-Fetch-Site` check (§4.2): CSRF is closed by that check, not by cookie strictness alone, since `Lax` on its own would not be enough.
3. **`API_AUTH_TOKEN` loses `ADMIN` and is disabled in production after cutover.** Confirmed (§4.10). It still authenticates as the reserved operator user for any remaining service-to-service use, scoped to that user's own resources like any other caller, and that remaining use is documented at the point it is exercised, not left implicit.
4. **Operator's testnet history: clean start, exported to an archive file first, never imported.** Confirmed (§4.12 stage 4). The earlier "a verified import is possible later" option is withdrawn: the record above no longer offers it.
5. **Email provider: SES.** Confirmed, with domain verification (SPF, DKIM, DMARC), leaving the SES sandbox, and bounce/complaint handling all in scope for the build, not left for later discovery (§4.5).
6. **No key export in v1, accepted, on the condition it ships with:** the sweep-funds action, a second sign-in wallet as the recovery path, and a clear warning at sign-up and first wallet creation (§4.5). Key export itself moves to follow-ups (§6).
7. **`/admin` network restriction: required from v1**, via an identity-aware access proxy (Cloudflare Access or Tailscale), explicitly not an IP allow-list (§4.10).
8. **Legal review before any external user; NDPR and GDPR both noted, jurisdiction pending business registration.** The notice, terms and retention periods in §4.13 are marked as drafts for that reason, not as finished copy.

**Added after this draft, not part of the original eight:**

- **Migration of existing password accounts.** New §4.15: a one-time bridge (old password, then a wallet-link step) for any account that exists at cutover; none are expected today. Password login and the two `users` columns are retired at build step 3, not kept open as a fallback.
- **The `mint_events` default-privileges fix ships in the same migration as the table**, with a test connecting as `stryx_app` that proves `DELETE` and an out-of-allow-list `UPDATE` both fail (§4.9), the same pattern the audit log already uses.
- **Mass session revocation** wires up the `user_sessions:{userId}` index ADR-002 promised and never built (§4.2, §2): this ADR treats it as required, not optional.
- **The schedule leak and open signup are being fixed as a separate, small hotfix**, tracked outside this document. This ADR references it (§4.7, §7) and does not redesign it here.

## 9. Consequences

**Positive**

- No password database and no reset flow to defend, and no email in the trust path.
- The mint history stops depending on which browser you used, and analytics, the feed and the boxes cannot disagree because there is one source.
- The existing cross-user leak in schedules is closed structurally, with a test that catches the next one.
- The operator account has a bounded blast radius that is enforced in Postgres and KMS, not just in handlers.
- The custody gap ADR-002 records (no owner at the signing layer) is closed cryptographically.

**Costs and accepted trade-offs**

- Sign-in needs a wallet extension or wallet browser today, and there is no mobile path until WalletConnect.
- Smart-contract wallet users cannot sign in at launch.
- No recovery if every sign-in wallet is lost, which is harsh for custody and must be said plainly.
- Step-up signatures add friction to Disperse from bot wallets, on purpose.
- Redis gains more load-bearing state (nonces, sessions, the user-session index, OAuth state). An outage means no sign-in, the same class as ADR-002 §6 already accepts.
- The mint log makes the reconciler load-bearing for settled statuses, and it depends on per-chain RPC health with no failover yet.
- Discord profiles are snapshots and go stale until refreshed, a direct result of keeping no tokens.
- "Users" in analytics means wallets that signed, not people.
- A privileged-role split (`stryx_app`, the migration role, `stryx_analytics`) is more operational surface, and each new table now needs its grants stated explicitly.
