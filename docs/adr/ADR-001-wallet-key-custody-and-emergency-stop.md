# ADR-001: Wallet Service Key Custody & Emergency Stop Design

**Status:** Proposed
**Date:** 2026-07-29
**Owners:** Platform Architecture
**Affected modules:** Wallet Service, Transaction Engine, Strategy Engine, Notification Engine

---

## 1. Context

Stryx (the NFT/Web3 automation platform) will generate, store, and autonomously use private
keys to sign and broadcast transactions across 15+ EVM chains. This is the single highest
blast-radius component in the system: a key custody failure results in direct, irreversible
loss of user funds, not degraded service.

The existing standards documents state only:

> "Private keys always encrypted using AES-256-GCM. Never stored in plaintext. Never logged."

This is necessary but not sufficient. It does not specify:

- Where the encryption key itself lives
- How keys are unwrapped for use without ever fully materializing on a compromised host
- How key rotation is handled once wallets are in production use
- What "emergency stop" actually halts, and how fast
- The threat model this design is defending against

This ADR resolves those gaps before the Wallet Service is implemented, because retrofitting
custody architecture into a live system holding funds is high-risk and disruptive.

---

## 2. Threat Model

We are explicitly designing against:

1. **Application server compromise** (RCE, dependency compromise, misconfigured access),
   attacker gets filesystem/process access but not infrastructure-level access.
2. **Database compromise** (SQL injection, backup leak, insider access to Postgres),
   attacker gets full read access to all tables.
3. **Credential/config leak** (`.env` committed, secrets manager misconfigured, log leak).
4. **Malicious or buggy Strategy Engine rule** causing unintended signing/spending.
5. **Insider risk**: an engineer with production DB access should not be able to
   single-handedly exfiltrate usable private keys.

We are explicitly **not** designing against a fully compromised KMS/cloud provider or a
compromised build pipeline that injects malicious code with legitimate KMS permissions,
those require separate controls (SBOM, code review gates, provider-level guarantees) outside
this ADR's scope.

A good design must ensure that **compromise of any single layer (app server OR database)
alone is insufficient to recover a usable private key.**

---

## 3. Decision

### 3.1 Envelope encryption with externally-held KEK

- Every wallet's private key is encrypted with a unique, randomly generated **Data Encryption
  Key (DEK)** (AES-256-GCM, unique IV per encryption operation).
- Each DEK is itself encrypted ("wrapped") by a **Key Encryption Key (KEK)** held in a managed
  KMS (AWS KMS, GCP Cloud KMS, or HashiCorp Vault Transit: provider chosen at deployment,
  abstracted behind a `KeyManagementProvider` interface so it's swappable).
- **The KEK never leaves the KMS.** The application never receives, holds, or has the
  technical ability to export the KEK. It only ever calls `kms.decrypt(wrappedDEK) → DEK` or
  `kms.encrypt(DEK) → wrappedDEK`.
- Postgres stores only: `encryptedPrivateKey` (AES-256-GCM ciphertext), `wrappedDEK`, `iv`,
  `authTag`, `keyVersion`. A full database dump is useless without live KMS access.

**Why this beats a single static encryption key in an env var:** a database leak alone yields
nothing usable. An application server compromise alone yields nothing usable (attacker can
call KMS *through* the app's identity, but each call is logged, rate-limitable, and revocable,
see 3.3). Both layers must be compromised *simultaneously and correlated* to extract a key,
which is a materially higher bar and is the industry-standard model (this is exactly how
Fireblocks/Coinbase Custody-style systems reason about custody, without requiring us to build
full MPC on day one).

### 3.2 Signing flow (key never persists unencrypted)

```
1. Transaction Engine requests signature for wallet W, tx payload P
2. Wallet Service loads encryptedPrivateKey + wrappedDEK + iv + authTag from Postgres
3. Wallet Service calls KMS: kms.decrypt(wrappedDEK) -> DEK (in-memory only)
4. Wallet Service decrypts encryptedPrivateKey with DEK -> raw private key (in-memory only)
5. Sign transaction P
6. Immediately zero out DEK and raw private key from memory (explicit buffer overwrite,
   not just dereference: V8 GC timing is not a security control)
7. Return signed transaction to Transaction Engine
8. Wallet Service never logs, caches, or persists the raw key or DEK at any point
```

Raw private key material exists in process memory for the shortest possible window: a single
synchronous signing operation: and never crosses a process/network boundary unencrypted.

### 3.3 KMS access control & auditability

- The application's KMS identity (IAM role / Vault AppRole) is scoped to `decrypt` and
  `encrypt` operations on this KEK **only**: no `export`, no key management operations.
- Every KMS decrypt call is logged by the KMS provider itself (CloudTrail / Vault audit log),
  independent of and unforgeable by the application. This gives us an authoritative,
  tamper-resistant log of every single moment a key was ever unwrapped, by which service
  identity, for which wallet: critical for post-incident forensics.
- KMS access is rate-limited and alertable: a sudden spike in decrypt calls for one wallet, or
  decrypt calls outside expected Transaction Engine call patterns, triggers an alert (see
  Notification Engine integration in §3.5).

### 3.4 Key rotation & versioning

- `keyVersion` column on the wallet key record from day one, even though v1 is the only
  version at launch. Retrofitting versioning into a live schema with funds attached is far
  riskier than including an unused column now.
- Rotation procedure: generate new DEK → decrypt private key with old DEK → re-encrypt with
  new DEK → wrap new DEK with current KEK → atomic DB update → increment `keyVersion`. This
  supports both DEK rotation (routine) and KEK rotation (if the KMS key itself is rotated or
  suspected compromised).
- Rotation is a scheduled background job, not manual: target: DEK rotation every 90 days,
  configurable per wallet tier (treasury wallets rotate more conservatively than hot trading
  wallets, TBD in a follow-up ADR on wallet tiering).

### 3.5 Emergency Stop: explicit propagation spec

The standards docs say "support emergency stop" with no latency target. This ADR defines it
concretely:

**Stop is a Redis flag, not a database row.** `emergency_stop:{scope}` where scope is
`global`, `wallet:{id}`, or `strategy:{id}`. Redis is chosen specifically because it's already
the platform's cache layer and gives single-digit-millisecond reads with no connection pool
contention against Postgres during an incident (when DB load may itself be elevated).

**Checkpoints: stop is checked at every one of these gates, not just at strategy trigger:**

| Stage | Check | Effect if stopped |
|---|---|---|
| Strategy evaluation | before evaluating any rule | strategy skipped entirely |
| Transaction build | before Transaction Builder runs | build aborted |
| Pre-simulation | before simulate call | aborted, no RPC call wasted |
| **Pre-sign** | immediately before Wallet Service is called | **hard stop**: this is the last point stop is guaranteed effective |
| Post-sign, pre-broadcast | best-effort check | broadcast skipped if caught in time, but a signed tx that already left the process cannot be recalled |

**Explicit limitation we accept:** once a transaction is signed and handed to the Broadcast
Manager, emergency stop cannot un-send it if broadcast has already started. This is a physical
reality of blockchain systems, not a design gap, but it means the pre-sign checkpoint is the
one that matters most, and the gap between "stop pressed" and "next pre-sign checkpoint
evaluated" is the true latency spec. Target: **<50ms** from Redis flag set to effect at the
pre-sign checkpoint, verified by a synthetic test that measures this end-to-end on every
deploy.

**Triggering emergency stop** is available via: Dashboard (single click, admin-role gated),
Telegram bot command (authorized users only, see §4), and an internal automatic trigger, if
the Risk Analyzer or KMS audit log anomaly detector (§3.3) fires above a configured severity,
the platform can self-trigger a scoped stop before a human acts.

### 3.6 Hot wallet consideration: MPC deferred, not dismissed

For wallets that sign frequently and automatically (mint bots, copy-trading), envelope
encryption still means a full private key materializes in process memory at signing time,
briefly. A threshold/MPC signing scheme (e.g., 2-of-3 key shares, no single share ever
reconstructing the full key) removes even that brief window entirely.

**Decision: defer MPC to a follow-up ADR, do not block Phase 1 on it.** Envelope encryption +
KMS + the audit/alerting above is a legitimate, defensible custody model on its own and is
what the majority of production Web3 platforms run at this stage. MPC is a real upgrade for
high-value hot wallets specifically, and should be scoped once we know actual wallet-tier
value distribution: building it prematurely against wrong assumptions is its own form of
technical debt.

---

## 4. Related, smaller decisions folded into this ADR

- **Telegram/Dashboard authorization for wallet-affecting actions** must map to specific
  wallet permissions per user (not "anyone who knows the bot"), rate-limited per identity, and
  every action audit-logged with the acting identity, required before emergency stop or any
  wallet action is exposed on those surfaces.
- **Secrets for the KMS identity itself** (the app's IAM credentials/AppRole token) follow the
  existing standard: environment variable or secrets manager, never committed, never logged,
  this ADR doesn't change that, it just clarifies that this credential grants *narrow*
  decrypt/encrypt scope, not the KEK itself.

## 5. Consequences

**Positive:**
- No single-layer compromise (DB-only or app-only) yields usable keys.
- Independent, tamper-resistant audit trail of every key access via KMS logs.
- Rotation is supported from day one without a future schema migration on a live funds system.
- Emergency stop has a measurable, testable latency guarantee instead of being a vague feature.

**Costs / tradeoffs accepted:**
- Every signing operation now requires a network round-trip to KMS (single-digit ms for
  AWS/GCP KMS, low double-digit ms for self-hosted Vault): acceptable given signing is not
  the sub-100ms internal-event-processing hot path; it's gated by chain block times anyway.
- Operational dependency on KMS availability, if KMS is down, signing is down. Mitigated by
  using a KMS provider with published >99.99% SLA and treating KMS outage as a defined incident
  class in the runbook, not a silent failure mode.
- MPC is deferred, meaning a genuine (if brief) window of raw key exposure remains for hot
  wallets until the follow-up ADR is implemented. This is a conscious, documented tradeoff, not
  an oversight.

## 6. Alternatives considered

| Alternative | Rejected because |
|---|---|
| Static app-level encryption key in env var / secrets manager | DB leak + config leak together, or config leak alone if key ever logged/cached, yields usable keys. Single layer of defense. |
| Full MPC from day one | Real complexity and integration cost before wallet-tier value distribution is known; premature optimization against an unquantified threat. |
| HSM-backed keys with no software decrypt path at all | Strongest option but highest operational cost/latency and least flexible for a fast-iterating Phase 1-3 roadmap; worth revisiting once treasury wallet value justifies it. |
| DB-level encryption only (e.g., Postgres TDE) | Protects data at rest on disk but not against application-level compromise or a live DB credential leak: doesn't meet the threat model in §2. |

## 7. Implementation follow-ups (not in this ADR)

- [ ] `KeyManagementProvider` interface + AWS KMS implementation (packages/blockchain or a new packages/security)
- [ ] Wallet Service repository layer updated for `wrappedDEK`, `iv`, `authTag`, `keyVersion` schema
- [ ] Emergency stop Redis flag + pre-sign checkpoint middleware in Transaction Engine
- [ ] Synthetic emergency-stop latency test in CI
- [ ] KMS audit log → anomaly detector → Notification Engine wiring
- [ ] Follow-up ADR: wallet tiering (treasury vs. hot vs. mint wallets) and MPC scoping for high-value hot wallets
- [ ] Follow-up ADR: Telegram/Dashboard authorization model for wallet-affecting commands
