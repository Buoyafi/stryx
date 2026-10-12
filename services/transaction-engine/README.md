# @stryx/transaction-engine

Orchestrates a transaction from an unsigned request to broadcast: gas estimation, simulation,
nonce allocation, signing, and the ADR-001 §3.5 emergency-stop checkpoint sequence, for real,
not just as a design doc.

## What this actually ties together

This package has almost no logic of its own: its job is composing pieces already built:

```
UnsignedTransactionRequest (e.g. from @stryx/nft-engine's SeaDropTransactionBuilder,
                             or anything else that produces { to, data, value })
        │
        ▼
TransactionEngine.executeTransaction(scope, unsignedTx)
        │
        ├─ EmergencyStopGuard.isStopped()      - checked at every stage below
        ├─ GasEstimator                         - viem estimateGas + estimateFeesPerGas
        ├─ TransactionSimulator                 - viem eth_call, catches reverts before signing
        ├─ @stryx/nonce-manager.getNextNonce()  - allocated only after simulation succeeds
        ├─ TransactionSigner                    - bridges to @stryx/key-management's
        │                                         WalletKeyService.withDecryptedPrivateKey()
        └─ viem sendRawTransaction               - broadcast
```

## The checkpoint sequence (ADR-001 §3.5, implemented literally)

| Stage | What happens if stopped |
|---|---|
| Strategy evaluation | Aborts before any RPC call at all |
| Transaction build (gas estimation) | - |
| Pre-simulation | Aborts before the eth_call |
| **Pre-sign** | **Hard stop**: the last point a stop is guaranteed effective |
| Post-sign, pre-broadcast | Best-effort: a stop in the gap between signing and this check can't be guaranteed caught |

Nonce handling follows the same logic: allocated only after simulation succeeds (no point
reserving a nonce for a transaction that would revert anyway), and released back to
`@stryx/nonce-manager`'s reuse pool on **any** failure between allocation and a successful
broadcast: emergency stop, a signing error, anything. Once `sendRawTransaction` succeeds, the
nonce is never released: the transaction has left this process and the chain may still confirm
it. This is the same "explicit limitation we accept" documented in ADR-001, not a gap, a
physical reality of blockchain systems.

## Why the tests matter here specifically

This is the first package where getting the crypto wrong would be silent and catastrophic: a
subtly wrong signing integration wouldn't throw an error, it would just produce a transaction
that either doesn't recover to the right address (so it'd never even reach the mempool
correctly) or, worse, appears to work in every test that doesn't check hard enough.

The test suite deliberately uses **real** `WalletKeyService` + `LocalKeyManagementProvider` (real
AES-256-GCM encryption, real key generation), a **real** `NonceManager`, and a **real**
`EmergencyStopGuard`: faking only the actual blockchain RPC boundary. The single most important
test independently recovers the signer address from the broadcast transaction's raw bytes via
`viem`'s `recoverTransactionAddress` and asserts it matches the wallet that was supposed to sign
it. That's not "does the code run": that's "is this cryptographically the right signature,"
checked by code with no shared logic with whatever produced the signature.

## Testing

```
npm test         # 7 tests: end-to-end broadcast, signature recovery, gas estimation call
                  # count, simulation-revert-blocks-nonce-allocation, global/wallet emergency
                  # stop at the earliest checkpoint, and stop-mid-flow-releases-the-nonce
npm run typecheck
```

## What's still needed before this runs for real

- A real `PublicClient` (viem) pointed at an actual RPC endpoint: tests use a fake.
- A real `WalletKeyRecordProvider` wired to `@stryx/wallet-service`'s repository (currently only
  a test double exists here, matching the decoupling pattern used elsewhere in this codebase).
- Confirmation tracking (`waitForConfirmation`) is implemented but not yet wired into any
  retry/re-broadcast logic for a stuck transaction: that's a reasonable next increment, not a
  gap in what's here today.
