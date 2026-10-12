# ADR-002: Multi-User Custody, Authentication & Authorization

**Status:** Accepted and implemented (2026-09-13 onward). **Partly superseded by ADR-003 (2026-09-21):** the password authentication parts only. Superseded passages are marked in place with a `Superseded` note and the original text is kept for the record. Everything not marked still stands.
**Date:** 2026-09-13
**Owners:** Platform Architecture
**Affected modules:** Wallet Service, Transaction Engine, API (auth, all controllers), Database schema, Key Management
**Supersedes:** the "Open decisions: Custody model" entry in `CONTEXT.md`. Does not modify ADR-001's cryptographic design.

---

## 1. Context

Stryx today is single-operator: one shared `API_AUTH_TOKEN` gates the entire API (`apps/api/src/auth.ts`),
every wallet row belongs to whoever holds that token, and `WalletRepository.findById(id)`
(`services/wallet-service/src/repository/wallet.repository.ts`) will return any wallet in the
database to any caller who can reach the API. This is fine for one operator. It is not a
foundation multiple users' funds can sit on.

**The custody decision is made, not open for debate in this ADR:** Stryx will remain custodial
for multi-user. The platform holds users' encrypted private keys so it can sign scheduled mints
without the user present: that unattended signing is the product's core value, and no
non-custodial model (session keys, wallet-connect-per-mint) delivers it without either much
greater complexity or breaking automation entirely (`CONTEXT.md`'s "Open decisions" section
weighed these; custodial wins for this phase). This ADR is about what custodial-for-many-users
requires that custodial-for-one-operator did not.

**Honest framing, stated plainly because it must be:** this IS custody. Users' funds' safety
depends entirely on our security engineering. We will not describe this to users as
"non-custodial," "you control your keys," or "we can't access your funds": none of that is
true, and ADR-001 §3.1 already establishes that the application, though it never holds the
plaintext KEK, *can* decrypt any wallet's key by calling KMS through its own service identity.
The accurate language for users: *"Stryx generates and encrypts your wallet's private key. We
never see it in plaintext during normal operation, and no single system component (database
alone, application server alone) can extract it, but Stryx's infrastructure custodies your
key material to make unattended minting possible. This is different from a self-custody wallet
like MetaMask, where only you ever hold the key."* This framing must appear wherever a user's
wallet is created, not just in a terms-of-service page nobody reads.

ADR-001 designed the cryptography for this correctly: envelope encryption, KMS-held KEK,
emergency stop: and none of that changes here. What ADR-001 did not design, because it
predates any notion of multiple tenants, is: whose wallet is this, who is allowed to touch it,
how do we prove that after the fact, and what happens when the system holding many users' funds
is a bigger target than the system holding one operator's.

---

## 2. Threat Model: additions to ADR-001 §2

ADR-001's five threat categories (app server compromise, DB compromise, credential/config leak,
malicious strategy logic, insider risk) all still apply and are unchanged. Multi-tenancy adds:

6. **Blast radius is now many users' funds in one system**, not one operator's. A single
   authorization bug (a missing ownership check on one endpoint) that would previously have been
   a non-issue, the operator already owns everything, becomes a direct path for User A to
   reach User B's wallet. This is the single biggest qualitative change this ADR exists to
   address, and it is why §3.3's structural enforcement is the load-bearing decision in this
   document.
7. **One compromised user account vs. a full platform breach are now different, distinguishable
   incidents**, and our controls must be able to tell them apart and contain each independently.
   A leaked password for User A must not, by itself, expose anything about User B: no shared
   secrets, no session design that lets one valid session imply anything about another account,
   and emergency-stop must be scopable to exactly the affected user without the operator
   reaching for the global kill switch (see §3.7).
8. **Insider risk is qualitatively worse.** ADR-001 §2.5 already assumed an engineer with DB
   access shouldn't be able to single-handedly exfiltrate a usable key: true here too, unchanged
   by KMS custody. What's new: an engineer (or a compromised operator/admin credential) now also
   sits in a position of trust over *other people's* funds, not just the operator's own. This
   raises the bar on audit logging from "nice for debugging" to "the only thing standing between
   us and an unaccountable insider": see §3.10.
9. **Authority tracing becomes a hard requirement, not a debugging convenience.** For any given
   wallet, we must be able to answer, after the fact: which human identities, and which code
   paths, were capable of causing it to sign? Before multi-tenancy this question had one boring
   answer ("the operator, via any endpoint"). With N users it has a combinatorial answer unless
   the system is designed so the answer stays small and enumerable: see §3.10.
10. **Multi-user account compromise via credential stuffing / reuse** is now a real, expected
    attack class (it wasn't meaningfully applicable to a single bearer token an operator
    generated themselves): this shapes the authentication decisions in §3.4.
    > **Superseded by ADR-003.** Sign-in is now a wallet signature, so there are no passwords to stuff or reuse. The account-isolation point of this item stands.

We continue to explicitly exclude a fully compromised KMS/cloud provider or compromised build
pipeline from this ADR's scope, per ADR-001 §2's closing paragraph: unchanged.

Smart-contract risk is explicitly out of scope for this ADR (and for Stryx generally): we call
SeaDrop, OpenSea's audited protocol, and do not author contracts ourselves. Our attack surface is
the backend described above.

---

## 3. Decision

### 3.1 The custody decision and its honest framing

Covered in §1: restated here because ADR structure keeps decisions numbered under §3:
**Decision: custodial, with KMS envelope encryption per ADR-001, extended to multiple tenants.**
Not revisited in this document. The honest-framing language in §1 is a decision, not
boilerplate: it must be reviewed by whoever writes user-facing copy before any real user
onboards, and revisited any time we change *how* custody works (e.g. if we ever add MPC per
ADR-001 §3.6, the framing improves, but does not become "non-custodial").

### 3.2 Multi-user data model

New table:

```
model User {
  id           String    @id @default(uuid())
  email        String    @unique
  passwordHash String
  role         UserRole  @default(USER)
  status       UserStatus @default(ACTIVE)
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  wallets      Wallet[]
}

enum UserRole {
  USER
  ADMIN
}

enum UserStatus {
  ACTIVE
  SUSPENDED
}
```

> **Superseded by ADR-003 §4.4 and §4.15 (in part).** `User.email` and `User.passwordHash` are replaced by `SignInWallet` rows (wallet identity), an optional verified `UserEmail`, and profile fields. `role`, `status`, the spend-cap columns and the `Wallet` relation below stand. The two columns are dropped only after existing password accounts have migrated (ADR-003 §4.15).

`Wallet` gains a required, non-nullable foreign key:

```
model Wallet {
  ...existing fields unchanged...
  userId String
  user   User   @relation(fields: [userId], references: [id])

  @@index([userId, status])
}
```

**Why non-nullable, not optional:** an optional `userId` would mean "some wallets have no
owner," which immediately reopens the exact ambiguity this ADR exists to close: a wallet with
`userId: null` is a wallet any authorization check has to special-case, and special cases are
where authorization bugs live. Every wallet has exactly one owning user, always, from the
schema up. §3.11 explains how this stays true for today's single-operator wallets without a
special-cased migration path.

Ownership is 1:1 (one user owns a wallet outright) for this ADR: no shared/team wallets. See
§4 for why that's deferred, not designed around.

### 3.3 Ownership enforcement: the structural invariant

This is the decision the user asked to get right above all others, so it's stated as a rule
before the mechanism: **it must be structurally impossible to construct a database query for a
wallet without an owner id, and that owner id must be able to originate only from verified
authentication state: never from a request body, query param, or path segment.** "Structurally
impossible" means: the compiler and the interface shape refuse to let you skip it, not "every
handler remembers to check."

**Mechanism.** `WalletRepository` (`services/wallet-service/src/repository/wallet.repository.ts`)
changes from:

```ts
findById(id: string): Promise<WalletRecord | null>;
updateStatus(id: string, status: WalletStatus): Promise<WalletRecord>;
delete(id: string): Promise<void>;
list(filter?: WalletListFilter): Promise<WalletRecord[]>;
// ...
```

to requiring an owner on every method that reads or writes a specific wallet or set of wallets:

```ts
findById(ownerId: UserId, id: string): Promise<WalletRecord | null>;
updateStatus(ownerId: UserId, id: string, status: WalletStatus): Promise<WalletRecord>;
delete(ownerId: UserId, id: string): Promise<void>;
list(ownerId: UserId, filter?: WalletListFilter): Promise<WalletRecord[]>;
// ...
```

`UserId` is a branded string type (`type UserId = string & { readonly __brand: 'UserId' }`,
minted only by the auth layer from a verified session: see §3.4), not a bare `string`. This is
the same "structural typing over hard dependencies" convention `CONTEXT.md` already calls out as
worth preserving, applied to identity instead of infrastructure interfaces: a raw string pulled
from `request.body.userId` (attacker-controlled) does not type-check as a `UserId` without
passing through the one function that mints it from a verified session, so a controller *cannot
accidentally* pass client-supplied data where an owner id is expected: the type system, not
programmer discipline, closes that path.

`PrismaWalletRepository` (`services/wallet-service/src/repository/prisma-wallet.repository.ts`)
implements this by folding `userId` into every Prisma `where` clause:

```ts
async findById(ownerId: UserId, id: string): Promise<WalletRecord | null> {
  const row = await this.wallet.findUnique({ where: { id, userId: ownerId } });
  return row ? WalletRecordSchema.parse(row) : null;
}
```

A wallet that exists but belongs to someone else returns `null` here: the same as "doesn't
exist": which `WalletService.getWalletSummary` already turns into `WalletNotFoundError`. **This
is deliberate: cross-user access fails as "not found," never as "forbidden."** A 403 would
confirm the wallet id exists and belongs to someone; a 404 (indistinguishable from a typo)
leaks nothing. This is the same enumeration-resistance reasoning already applied in
`auth.ts`'s `timingSafeEqual` token comparison, extended to resource lookups.

Mutating operations use Prisma's `updateMany`/`deleteMany` with the compound `{ id, userId }`
filter and check the affected-row count, rather than `update`/`delete` with `{ id }`: the
Prisma-generated single-row `update`/`delete` throws on zero matched rows in a way that's easy
to mis-handle; an explicit count check makes "this wallet doesn't belong to you" an intentional,
tested branch rather than an uncaught Prisma exception falling through to a generic 500 (exactly
the failure mode `CONTEXT.md` Gotcha #6 already documents happening for an unrelated reason,
we are not adding a second way to produce it).

**Why the repository interface itself, not a per-request "scoped wrapper" object:** a wrapper
(`walletRepository.forUser(userId)` returning a narrowed interface) was considered and rejected
as the *primary* mechanism, because it still relies on whoever wires dependency injection at the
app's composition root remembering to call `.forUser(...)` instead of reaching for the
unscoped repository: one composition-root mistake and the wrapper is bypassed entirely, silently.
Changing the interface itself means there *is no unscoped repository left to reach for*: every
call site in the entire codebase fails to compile without an owner id. This is strictly stronger
and costs nothing at runtime.

`WalletService` (`services/wallet-service/src/service/wallet.service.ts`) threads `ownerId`
through the same way: every one of its methods (`getWalletSummary`, `listWallets`,
`renameWallet`, `archiveWallet`, `rotateWalletKey`, `deleteWalletPermanently`, etc.) takes
`ownerId: UserId` as its first parameter and passes it straight to the repository. Controllers
never see a repository directly; they call `walletService.getWalletSummary(request.userId, id)`,
where `request.userId` is populated by the auth hook (§3.4) from the session, before any route
handler runs: the same "onRequest hook, default-on" pattern `auth.ts` already uses for Level 1
auth, extended to also attach identity, not just gate access.

### 3.4 Authentication

> **Superseded in part by ADR-003.** What stands: sessions rather than JWT, the Redis store keyed by the SHA-256 of an opaque token, sliding expiry with an absolute cap, instant revocation. What changes: the credential is a SIWE wallet signature (ADR-003 §4.1), the token travels in an httpOnly `SameSite=Lax` cookie instead of a bearer header (ADR-003 §4.2, where the `Strict` below is deliberately changed to `Lax` and the reason is given), the `user_sessions:{userId}` index this section relies on is built with a revocation watermark (ADR-003 §4.2), and sensitive actions need step-up signatures. Password storage, recovery and the MFA deferral below are replaced as marked.

**Sessions, not JWT.** JWTs are attractive for statelessness, but statelessness is exactly the
wrong property here: §2's threat model addition #7 requires that a single compromised account be
instantly containable, and a stateless JWT is valid until it expires no matter what we do
server-side unless we maintain a revocation list, at which point we've built a session store
anyway, with extra complexity and a worse security property in the gap before the blocklist is
checked. Redis is already the platform's session/cache layer per the existing standards, so:

- On login, mint a random 256-bit session token, store `SHA-256(token) → { userId, issuedAt,
  lastSeenAt }` in Redis under `session:{hash}`, return the raw token to the client (httpOnly,
  Secure, SameSite=Strict cookie for the dashboard; the raw token is never itself persisted,
  same principle as never storing the shared operator token anywhere but the comparison itself).
- TTL with sliding expiry: refreshed on each authenticated request, hard-capped at an absolute
  maximum lifetime (e.g. 30 days) forcing re-login even for an active session, bounding how long
  a stolen-but-unused session cookie stays valid.
- Revocation is then a single `DEL session:{hash}`: instant, and exactly the tool needed to
  contain one compromised account without touching anyone else's session, satisfying the
  isolation requirement in threat-model addition #7.
- The auth hook looks up `session:{hash}` on every request the same way `auth.ts` currently does
  `timingSafeEqual` against `API_AUTH_TOKEN`: same shape of check, same "reject before any
  handler runs" placement, just backed by Redis instead of a static comparison.

> **Superseded by ADR-003 §4.1 and §4.15.** No passwords are stored after migration. argon2id remains only until existing password accounts have linked a wallet.

**Password storage:** argon2id, not bcrypt: memory-hard, current best practice, and this
project already treats "current best practice over convention" as a value (see ADR-001 choosing
KMS envelope encryption over a static key). Only the hash is stored; `passwordHash` in §3.2's
schema.

> **Superseded by ADR-003 §4.5.** Recovery is by linking multiple sign-in wallets plus a sweep-funds action. There is no password reset, no email recovery and no operator-assisted reset.

**Recovery:** deferred in this ADR's shipped scope: see §4. No email-delivery infrastructure
exists in this codebase today (no outbound mail provider is wired anywhere), so a proper
single-use, short-TTL, hashed reset-token flow is real work this ADR chooses not to hide inside
"just add a reset endpoint." Interim: operator-assisted reset (an ADMIN-role action that
force-invalidates a user's password and all their sessions, requiring them to set a new password
on next login) is acceptable for a small early user base and reuses infrastructure this ADR
already builds (sessions, roles).

> **Superseded by ADR-003 §4.2.** A wallet signature is the credential, hardware wallets provide the second factor, and money-moving actions require action-bound step-up signatures.

**MFA:** explicitly deferred, explicitly flagged as needed before real funds onboard at any
scale: see §4.

### 3.5 Authorization: roles, and the operation-ownership check

Two roles: `USER` (owns and operates their own wallets, and only their own) and `ADMIN`
(operator-level: can trigger a global emergency stop, can suspend a user account, can view
cross-user aggregate data for support/incident response, but does **not** get a bypass on the
wallet-ownership check in §3.3. An admin who needs to act on a specific user's wallet during an
incident does so through an explicit, audit-logged "act as" path that still resolves to that
user's `ownerId`, never through a `WalletRepository` method that skips ownership filtering. There
is no `findByIdAsAdmin(id)` method: see §3.3's point about there being no unscoped repository
left to reach for. This is deliberate: an admin bypass path is exactly the kind of "just this one
exception" that becomes the authorization bug threat-model addition #6 warns about.

> **Extended by ADR-003 §4.10.** The two roles stand. ADR-003 adds how `ADMIN` is designated (only the migration role can set it, so a compromised app cannot promote an account), structural enforcement of the admin check, step-up for sensitive admin actions, and audit logging of admin reads.

`ENGINEERING_STANDARDS.md` states "Authorization: Enforced at the service layer." §3.3 goes
further (enforcement at the repository layer, one level below the service) because "the
service layer checks it" still depends on every service method remembering to check, which is
exactly the per-handler-discipline pattern this ADR is designed to not depend on. The service
layer remains where the *rule* ownerId flows from is expressed (it's the thing that takes
`ownerId` as a parameter and is impossible to call without one); the repository is where it's
*enforced* against the actual data. Both matter; the repository is the one that fails closed if
the service layer is ever wrong.

### 3.6 Per-user isolation of existing features

Every existing feature that touches a wallet id goes through `WalletService`/`WalletRepository`,
so §3.3's change is largely sufficient: the remaining work per feature is making sure `ownerId`
actually reaches that call, and closing feature-specific gaps:

- **Balances** (`apps/api/src/balance.service.ts`, `wallet-ops-controller.ts`'s
  `listWallets()` call): becomes `listWallets(ownerId)`; a user's balance view can only ever
  enumerate their own wallets. No other change needed; per-chain timeout/error handling is
  unaffected.
- **Disperse** (`apps/api/src/disperse.service.ts`): the source wallet must resolve through
  the owner-scoped repository (draining funds requires signing, which requires the wallet to be
  yours). **Gap this ADR must close explicitly:** `DisperseRecipient.address` is documented in
  the code as accepting "a walletId to resolve to one of your own wallets": that resolution
  must *also* go through the owner-scoped repository, so a recipient walletId can only ever
  resolve to one of the caller's own wallets, never disclose or target another user's wallet by
  id. A recipient given as a raw `0x` address is unaffected (sending to any address is normal);
  the risk is specifically walletId-as-recipient.
- **Mint** (`apps/api/src/mint-controller.ts`, `allowlist-mint-controller.ts`,
  `mint-execution.service.ts`): `MintExecutionService.executePublicMint`/`executeAllowListMint`
  call `walletService.getWalletSummary(walletId)` today; becomes
  `getWalletSummary(ownerId, walletId)`. Without this, a user could mint through anyone's
  wallet just by guessing/enumerating a UUID: this is the single most direct fund-loss path
  multi-tenancy opens up, and it's closed by the exact same mechanism as every other feature,
  not a bespoke check.
- **Schedules** (`apps/api/src/mint-scheduler.ts`, `schedule-controller.ts`,
  `auto-schedule.service.ts`): the harder case, because the BullMQ worker that executes a
  scheduled mint runs with no HTTP request and no session: there is no "caller" to check
  ownership against at execution time in the normal sense. Resolution: `ScheduledMintJob`
  gains a `userId: UserId` field, captured from the authenticated session at schedule-creation
  time and stored in the Redis-persisted job payload alongside `walletId` (same place
  `autoRescheduleRemaining` already lives). At execution, the worker re-resolves the wallet via
  `getWalletSummary(job.userId, job.walletId)` before doing anything else, if the wallet was
  deleted, reassigned, or the user's account suspended between scheduling and firing, this fails
  closed with a clear reason, the same "never trust state captured at schedule time" principle
  `mint-scheduler.ts`'s own comments already apply to chain state, extended to ownership state.
  This also directly serves §3.10's authority-tracing requirement: the job payload itself is
  the durable record of who scheduled a mint that fires unattended later.

### 3.7 Per-user limits and controls

- **Spending caps.** A new Redis-backed counter, `spend:{userId}:{yyyy-mm-dd} → cumulative wei
  sent`, checked at the same pre-sign checkpoint `EmergencyStopGuard` already occupies in
  `TransactionEngine.executeTransaction` (`services/transaction-engine/src/service/transaction-engine.service.ts`).
  Exceeding a configurable per-user daily cap fails the transaction before signing with a
  specific `spending_cap_exceeded` reason: following the existing convention (`not_eligible`,
  `emergency_stop_active`, `simulation_reverted`) of specific, actionable error codes rather than
  a generic rejection. Caps are configured per user (a column on `User`, defaulting to a
  platform-wide default), not hardcoded, so the operator's own account can be configured with a
  much higher or no cap without special-casing "the operator" in code.

  **Recorded gap (added 2026-09-19, not part of the original design discussion):** the cap is
  scoped to the user only: one counter per user per day, with no per-wallet share of it. A
  single wallet (its key leaked, or its own logic misbehaving) can spend the user's *entire*
  daily allowance in that one wallet's name before the cap ever engages; the cap bounds what the
  account can do in a day, not what any one wallet within it can do. Per-wallet scoping wasn't
  considered when this section was written: it's an omission being logged now, not a trade-off
  that was weighed and rejected at the time. What it would buy if added later: containing damage
  to one compromised key (a per-wallet sub-limit) rather than only bounding the account's total
  exposure (what today's per-user cap already does). Left unbuilt for now because per-user
  already addresses the primary risk (bounding total account damage), a per-wallet limit is
  defence-in-depth for the narrower single-leaked-key scenario, and there are no real users yet
  for the gap to matter operationally.

  **Closed (2026-10-02):** each wallet now has its own daily budget inside its owner's, on every
  chain: `WALLET_DAILY_SPEND_SHARE_PERCENT` of the account's cap there (default 50%, 100 turns it
  off), reserved alongside the account's at the same pre-sign checkpoint
  (`spend:{userId}:{chainId}:wallet:{walletId}:{day}`) and released with it if the send fails. An
  unlimited account has unlimited wallets. See `CONTEXT.md`, "Recently resolved".
- **Per-user emergency stop.** `EmergencyStopGuard` (`services/transaction-engine/src/service/emergency-stop.service.ts`)
  currently supports exactly two scopes, `global` and `wallet:{id}`, checked together in
  `isStopped`. This ADR adds a third: `user:{id}`, checked alongside the other two. This gives
  two new, independently useful capabilities that don't exist today: a user can stop *all* of
  their own wallets at once without touching anyone else's (self-service incident response,
  no operator involvement needed), and an ADMIN can stop one user's entire account without
  reaching for the platform-wide `global` flag (blast-radius-appropriate response, per threat-model
  addition #7's isolation requirement). Implementation is a direct extension of the existing
  `globalKey()`/`walletKey()` pattern: a `userKey(userId)` following the same shape, no change
  to the class's external shape beyond one more scope.

### 3.8 Real secret management, required before any user onboards

**Current state, checked directly against the code, not assumed:** `AwsKeyManagementProvider`
(`packages/security/key-management/src/aws-key-management-provider.ts`) exists and is already
wired into the factory (`apps/api/src/kms-provider.ts` switches on `KMS_PROVIDER`): it is not
vaporware. What is genuinely missing:

- **Zero test coverage.** `packages/security/key-management/tests/` covers
  `envelope-encryption.test.ts` and `wallet-key-service.test.ts` against
  `LocalKeyManagementProvider`/a fake KMS provider only. `AwsKeyManagementProvider` has never
  been exercised by a single test, against a fake client or a real one.
- **Never exercised against a real AWS KMS key.** The IAM scoping ADR-001 §3.3 requires (decrypt
  + encrypt on this key only, no export, no key-management operations) has never been written or
  applied: it's a design requirement on paper, not an existing policy.
- **The KEK rotation half of ADR-001 §3.4's procedure has never been run**, against Local or AWS.

**Required before user #1 who isn't the operator onboards:**
1. Unit tests for `AwsKeyManagementProvider` against a mocked `MinimalKmsClient` (cheap, no AWS
   dependency, closes the "zero coverage" gap immediately).
2. An integration test against a real (disposable, test-account) AWS KMS key exercising
   `wrapDek`/`unwrapDek` round-trip and confirming a malformed/unauthorized call fails the way
   `KmsOperationError` expects.
3. The actual least-privilege IAM role/policy from ADR-001 §3.3, applied to whatever compute
   identity runs the API in production: written down as part of this rollout, not left implicit.
4. `LOCAL_KMS_KEK` in a `.env` file is explicitly declared **not acceptable for any environment
   holding a real user's funds**: `CONTEXT.md` Gotcha #2 already documents this key's blast
   radius for the single-operator case (lose it, every wallet is permanently dead); with other
   people's money behind it, "a file on a developer's disk" is not a defensible control. The
   app's own KMS-calling credentials move to the existing standard ADR-001 §4 already states
   (secrets manager, never committed): this ADR doesn't change that guidance, it makes it
   non-optional.
5. A one-time end-to-end run of the DEK/KEK rotation procedure (ADR-001 §3.4) against the real
   AWS provider, before launch, so the first time it's ever exercised isn't during a real
   incident.

None of this is a rewrite: `KeyManagementProvider`'s interface (§ADR-001 3.1) was designed to be
swappable specifically so this cutover is "point `KMS_PROVIDER` at `aws`, provision the key,"
not a code change. The gap is entirely test coverage and infra provisioning, not architecture.

### 3.9 Credential rotation policy

ADR-001 §3.4 established the DEK/KEK rotation *mechanism* and named a target (90 days) without
making it an actual running policy: `rotateWalletKey` exists and works but nothing schedules
it. This ADR makes the policy concrete:

| What | How often | Triggered by |
|---|---|---|
| Wallet DEK | Every 90 days, per wallet (configurable per tier (TREASURY conservative, MINT/HOT more frequent, per ADR-001 §3.4's original TBD, still TBD as a follow-up but no longer blocking scheduling the default) | A new recurring BullMQ job (the project's existing queue) see `mint-scheduler.ts` for the established pattern) walking wallets past their rotation window. Also on-demand via the existing `rotateWalletKey` API, unchanged. |
| KMS KEK (CMK) | Annual | AWS KMS's own built-in automatic key rotation, enabled on the CMK at provisioning time (§3.8 item 3): no custom code needed for the routine case. |
| User session | Sliding expiry, absolute cap ~30 days (§3.4) | Inactivity (sliding) or the absolute cap forcing re-login regardless of activity. |
| User password | No forced periodic rotation | Current guidance (NIST 800-63B) is against arbitrary password expiry: it drives weaker passwords, not better security. Rotation is event-triggered instead (see below), not calendar-triggered. **Superseded by ADR-003: there are no passwords.** |

**On suspected compromise (of a wallet, a user account, or the KEK itself): the incident
runbook this ADR defines, not left to improvisation:**
1. Immediately trigger `EmergencyStopGuard` at the smallest sufficient scope: `wallet:{id}` for
   one suspected wallet, `user:{id}` (§3.7, new in this ADR) for a suspected account, `global`
   only for a suspected platform-wide event.
2. Force-rotate the specific wallet's DEK via the existing `rotateWalletKey` path immediately,
   not waiting for the scheduled 90-day pass.
3. If the KEK itself is suspected compromised: rotate the KMS CMK and re-wrap every wallet's DEK
   under the new key version: this needs a new batch-rotation script (§8), since today's
   `rotateWalletKey` operates one wallet at a time; the `keyVersion` column (ADR-001 §3.4) already
   supports this, it's just never been exercised at fleet scale.
4. Invalidate every active session for the affected user (`DEL` every `session:{hash}` mapping
   to that `userId`: requires a secondary Redis index `user_sessions:{userId} → Set<hash>`,
   maintained alongside session creation, since Redis has no native "find keys by value"), or
   every session platform-wide for a global event.
5. Record the incident as a distinct `security_incident` audit action (§3.10), separate from
   routine rotation, so it's forensically distinguishable later.

### 3.10 Audit logging and authority tracing

Two related but distinct requirements:

**Audit logging**: every wallet-affecting action recorded with the acting identity, in a form
that survives the actor trying to hide it. Concretely: a new `AuditLog` table
(`id, actorUserId, actorType ['user'|'admin'|'system'], action, walletId?, targetUserId?, outcome,
detail, createdAt`), written on every create/rename/archive/delete/rotate/mint/disperse/
emergency-stop/session action. **"Survives the actor trying to hide it"** is a specific,
checkable property, borrowed directly from ADR-001 §3.3's reasoning about KMS's own logs being
"independent of and unforgeable by the application": an audit row written by the same
application-layer code path that could be compromised is not independent of that compromise. So:
the database role the API uses for normal operation is granted `INSERT` but not `UPDATE` or
`DELETE` on `AuditLog` (a Postgres-level `REVOKE`, not an application-level rule, enforced
outside the code that could be compromised, same principle as the KEK never being reachable by
the app). Where feasible, audit events are additionally forwarded to an external, append-only
sink (the existing NATS event bus, per the standards doc, is the natural transport) so a full
database compromise still leaves an independent trail, mirroring ADR-001 §3.3's KMS-log
independence for the DB-compromise case specifically.

**Authority tracing**: for any wallet, the ability to answer "which identities and which code
paths can cause this to sign?" This is a design property, not just a logging one, and this ADR's
own decisions are what make the answer small and enumerable rather than combinatorial:
- Every code path capable of reaching `TransactionEngine.executeTransaction` (the sole place
  signing happens, unchanged from ADR-001) is enumerable by reading the codebase: HTTP mint,
  HTTP disperse, and the scheduled-mint worker. No other path exists.
- Every one of those three paths, after §3.3/§3.6, requires an `ownerId` that resolves to
  exactly one `User` row: the HTTP paths from a live session, the scheduled path from the
  `userId` captured in the job payload at schedule time (§3.6).
- Therefore the answer to "which identities can cause wallet W to sign" is always: exactly the
  one user who owns W (via HTTP, live), plus the scheduler worker acting on that same user's
  behalf for any jobs they scheduled (via the stored `userId`): never a second user, and never
  an ambiguous "the system, on someone's behalf" with no recoverable identity. This is checkable
  by code review, not just asserted, precisely because §3.3 made the owner id impossible to
  substitute at the type level.
- Combined with the audit log, "who caused this wallet to sign at 3am" is always answerable from
  two sources that agree: the job payload (who scheduled it) and the audit row (that it executed,
  and how): not reconstructable only from memory of what the code used to do.

### 3.11 Preserving single-operator mode

The user runs this daily today via the shared `API_AUTH_TOKEN` and that must keep working
unmodified. Resolution: at migration time, create one reserved `User` row (role `ADMIN`)
representing today's operator identity, and backfill every existing `Wallet.userId` to point at
it. The existing `API_AUTH_TOKEN` bearer-token check in `auth.ts` is extended (not replaced) to,
on a match, attach that reserved user's id as `request.userId`: exactly the same shape a session
lookup attaches a regular user's id. Every downstream call (`walletService.getWalletSummary(request.userId,
id)`, etc.) is completely unaware whether `request.userId` came from the legacy bearer token or
a real session; §3.3's structural enforcement applies identically either way, and the operator's
existing wallets, schedules, and workflow keep working exactly as they do today, because in the
new model, the operator was always just a user, we're only now naming that.

> **Amended by ADR-003 §4.10.** After the wallet sign-in cutover the shared token still resolves to the reserved operator user for owner-scoped use but **no longer carries ADMIN**, and it is disabled in production unless explicitly enabled. Admin access is only through the operator's SIWE session, behind an identity-aware proxy. The reserved user receives its real sign-in wallet through an `operator:adopt` script, so its existing wallets stay under the same `userId`.

---

## 4. Explicitly not doing yet (and why)

- **Multi-factor authentication.** *(Superseded by ADR-003 §4.2.)* Genuinely important once real funds are broadly onboarded,
  flagged, not dismissed. Sequenced after core multi-tenancy (§3.2-3.6) ships, because MFA on
  top of a single-tenant-shaped auth system would need rework anyway once sessions/roles exist.
- **Self-service, email-based password reset.** *(Superseded by ADR-003 §4.5: no passwords, and email plays no recovery role.)* No outbound email infrastructure exists in this
  codebase today. Building a correct single-use/short-TTL reset flow *and* an email provider
  integration in the same ADR as multi-tenant ownership enforcement would dilute review focus on
  the part that actually guards funds. Interim: operator-assisted reset (§3.4), which reuses
  infrastructure this ADR already builds.
- **Team/org accounts and shared wallet ownership.** §3.2's data model is deliberately 1:1
  (one wallet, one owner). Shared ownership (a wallet multiple users can jointly operate) is a
  meaningfully different authorization model: "does this user have permission on this wallet"
  becomes a many-to-many grant, not a foreign key, and building it speculatively now, before any
  user has asked for it, is exactly the kind of premature complexity this codebase's conventions
  (see `CONTEXT.md`) already argue against.
- **Session device management** (a user viewing/revoking individual active sessions themselves).
  The secondary `user_sessions:{userId}` index (§3.9) needed for admin-triggered mass revocation
  makes this straightforward as a later addition, not built now because nothing in this ADR's
  own security requirements depends on the user-facing UI for it.
- **Differentiated per-tier DEK rotation cadence** (TREASURY vs. HOT vs. MINT). ADR-001 §3.4
  flagged this as TBD in a wallet-tiering follow-up ADR; still TBD. §3.9 ships one default
  cadence so rotation actually runs on a schedule for the first time, without blocking that on a
  tiering ADR that doesn't exist yet.
- **MPC / hardware-backed signing.** Unchanged from ADR-001 §3.6, still deferred, still not
  dismissed, still not this ADR's problem to re-litigate.
- **Automatic anomaly-detection-triggered stops** scaled to multi-user. ADR-001 §3.5 already
  named this as depending on a Risk Analyzer that doesn't exist; still doesn't. §3.7's per-user
  emergency stop is a manually/admin-triggered control, not an automated one.
- **A dashboard UI for configuring per-user spending caps.** §3.7 designs the enforcement
  mechanism (it has to exist for the ADR to be complete); the operator UI to *set* caps
  per-user is an implementation task that follows from, but isn't blocked by, this ADR.

---

## 5. Related, smaller decisions folded into this ADR

- **The existing single-operator bearer token is not deprecated.** Per §3.11, it becomes one
  more way to authenticate as a (now explicit) `User` row, rather than a separate parallel auth
  system living alongside sessions. One auth model, two ways to satisfy it.
- **`WalletNotFoundError` remains the error thrown for cross-user access** (§3.3): no new error
  type is introduced for "exists but not yours," deliberately, per the enumeration-resistance
  reasoning in §3.3.
- **Disperse recipients given as raw addresses are unaffected by this ADR** (§3.6), only
  walletId-as-recipient resolution is newly scoped. Sending funds to an arbitrary address you
  don't own is normal, expected behavior, unrelated to custody of that address's key.

## 6. Consequences

**Positive:**
- Cross-user wallet access becomes a compile-time-impossible category of bug, not a
  per-endpoint discipline problem: closing the exact gap threat-model addition #6 describes.
- Emergency stop gains the granularity (`user:{id}`) that multi-tenancy actually needs, as a
  small extension of an already-correct design rather than a redesign.
- Authority over any given wallet is enumerable and auditable, by construction, satisfying §3.10
  as a property of the design rather than a hope about logging coverage.
- Today's single-operator workflow is unaffected: no migration pain for the user's daily use.

**Costs / tradeoffs accepted:**
- Every `WalletRepository`/`WalletService` call site in the existing codebase (`mint-execution.service.ts`,
  `disperse.service.ts`, `wallet-ops-controller.ts`, `schedule-controller.ts`, and their tests)
  must be updated to thread `ownerId` through. This is mechanical but touches most of `apps/api`.
- Scheduled jobs get slightly heavier payloads (`userId` added) and the worker does one more
  lookup (re-resolving ownership) per execution: negligible against existing per-execution chain
  reads.
- Real KMS (§3.8) is now a hard launch blocker where it was previously an aspirational
  improvement: this is deliberately a stricter bar than before, because the honest-custody
  framing in §1 requires it to be true, not just documented.
- Session-based auth means Redis becomes load-bearing for authentication, not just performance,
  a Redis outage now also means nobody can log in (mitigated the same way ADR-001 §5 accepts a
  KMS-availability dependency: treat it as a defined incident class, not a silent failure mode).

## 7. Alternatives considered

| Alternative | Rejected because |
|---|---|
| Non-custodial (session keys / account abstraction) | Decided against in §1: significant complexity, chain/wallet support dependent, and doesn't clearly beat custodial for this phase's priorities. Not re-litigated here. |
| Wallet-connect, user signs each mint | Breaks the core value proposition (unattended scheduled minting) outright. |
| Per-request scoped repository wrapper (`repo.forUser(id)`) as the *primary* enforcement mechanism | Still bypassable at the composition root by reaching for the unscoped repository underneath; §3.3 explains why changing the interface itself is strictly stronger. |
| JWT-based stateless auth | Can't be instantly revoked without a blocklist (which is a session store by another name), and threat-model addition #7 requires instant single-account containment. |
| Role-based admin bypass on wallet lookups (`findByIdAsAdmin`) | Reintroduces exactly the "just this one exception" pattern that causes the authorization bugs multi-tenancy is newly exposed to (§3.5). |
| Forced periodic password rotation | Current security guidance (NIST 800-63B) finds it counterproductive; event-triggered rotation (§3.9) is used instead. |
| Nullable `Wallet.userId` with "unowned = operator" convention | Reopens the exact ambiguity (a wallet with no clear, enforced owner) this ADR exists to close; every non-nullable-FK enforcement point would need a null special-case. |

## 8. Implementation follow-ups (not in this ADR)

- [ ] `User` model + migration; backfill reserved operator `User` row and existing `Wallet.userId` (§3.2, §3.11)
- [ ] `UserId` branded type; `WalletRepository`/`WalletService` interface changes threading `ownerId` through every method (§3.3)
- [ ] Session store (Redis) + login/logout endpoints + auth hook extension to attach `request.userId` from either a session or the legacy bearer token (§3.4, §3.11)
- [ ] ~~argon2id password hashing on signup/login (§3.4)~~ Superseded by ADR-003 (built, and retired per ADR-003 §4.15)
- [ ] `user_sessions:{userId}` secondary Redis index for mass session revocation (§3.9). **Never built; moved to ADR-003 §4.2** (with a revocation watermark)
- [ ] Update every mint/disperse/schedule/balance call site to pass `ownerId` (§3.6): largest mechanical change, high test-coverage priority
- [ ] `ScheduledMintJob` gains `userId`; worker re-resolves ownership at execution time (§3.6)
- [ ] `EmergencyStopGuard` gains `user:{id}` scope (§3.7)
- [ ] Spending-cap Redis counter + `transaction-engine` pre-sign check + `spending_cap_exceeded` error code (§3.7)
- [ ] `AwsKeyManagementProvider` unit tests (mocked client) + integration test against a real test-account KMS key (§3.8)
- [ ] IAM least-privilege policy for the KMS-calling identity, written and applied (§3.8)
- [ ] Recurring DEK-rotation BullMQ job; enable AWS KMS automatic annual CMK rotation (§3.9)
- [ ] Fleet-wide KEK re-wrap batch script, for the suspected-KEK-compromise runbook step (§3.9)
- [ ] `AuditLog` table + insert-only DB role grant + write call sites on every wallet-affecting action (§3.10)
- [ ] ~~Operator-assisted password reset (ADMIN action) (§3.4)~~ Superseded by ADR-003 §4.5 (no operator-assisted recovery)
- [ ] Follow-up ADR: wallet tiering and differentiated rotation cadence (still owed from ADR-001 §7, unchanged)
- [ ] Follow-up ADR: team/org accounts and shared wallet ownership, if/when requested (§4)
