# @stryx/nonce-manager

Redis-backed, chain-agnostic nonce allocation for the Transaction Engine.

## Why this exists

Per the platform's RPC strategy, every chain has multiple RPC providers with automatic
failover. If nonce state is derived fresh from `eth_getTransactionCount` on whichever provider
happens to answer, a failover mid-flight can hand two in-flight transactions the same nonce,
or skip one entirely. This package makes nonce allocation independent of which RPC provider is
currently active: **Redis, owned exclusively by this service, is the single source of truth**
for "what nonce do I use next," per wallet, per chain. The chain itself is consulted only to
bootstrap a wallet's counter the first time it's used, and to reconcile drift if it's ever
detected: never on the per-transaction hot path.

## Design summary

- **Allocation** (`getNextNonce`) is a single atomic Redis operation per call (`ZPOPMIN` to
  check the reuse pool, or `INCR` on the counter). No locks or transactions needed on the hot
  path: concurrent callers for the same wallet never receive the same nonce.
- **Cold-start initialization** is protected by a short-lived distributed lock (`SET NX PX`),
  so concurrent first-callers for a wallet don't each seed the counter from a different chain
  read.
- **Release** (`releaseNonce`) returns a nonce to a reuse pool when a transaction is aborted
  *before broadcast*: e.g. an emergency-stop pre-sign checkpoint fires, simulation fails, or
  signing errors. This avoids burning a permanent gap in the wallet's nonce sequence every time
  a transaction doesn't make it to the chain. **Never call this after a transaction has left
  the process**: the chain may still confirm it.
- **Reconciliation** (`resync` / `forceResyncToChain`) is intentionally conservative: if the
  chain reports a pending nonce *higher* than local state, that's treated as a hard error
  (`NonceReconciliationError`) requiring operator review, not silently auto-corrected: it
  means either Redis lost data or something bypassed this manager, and both are worth
  investigating rather than papering over. Local state being *ahead* of chain state is the
  expected steady state (transactions sitting in the mempool) and is not an error.

See `ADR-001-wallet-key-custody-and-emergency-stop.md` for how this interacts with the
emergency-stop pre-sign checkpoint and the Transaction Engine's signing flow.

## Usage

```ts
import { NonceManager, ViemChainNonceReader } from '@stryx/nonce-manager';
import Redis from 'ioredis';
import { createPublicClient, http } from 'viem';

const redis = new Redis(process.env.REDIS_URL!);
const publicClient = createPublicClient({ transport: http(rpcUrl) });
const chainNonceReader = new ViemChainNonceReader(publicClient);

const nonceManager = new NonceManager(redis, chainNonceReader, {}, logger);

// Transaction Engine, pre-sign checkpoint:
const nonce = await nonceManager.getNextNonce({ chainId: 4663, walletAddress });

try {
  // ...build, simulate, sign, broadcast...
} catch (err) {
  // Aborted before broadcast: return the nonce for reuse.
  await nonceManager.releaseNonce({ chainId: 4663, walletAddress }, nonce);
  throw err;
}
```

### Injecting a real Redis client

This package does not depend on `ioredis` directly: it depends on the narrow
`NonceRedisClient` structural interface in `src/types.ts`. Any client satisfying that shape
works, including a real `ioredis` instance:

```ts
import Redis from 'ioredis';
const redis = new Redis(process.env.REDIS_URL!);
// ioredis implements get/incr/exists/del/set/zadd/zpopmin/zrem/zcard/eval natively.
```

This keeps the package's own dependency tree minimal and makes it trivial to unit-test with
the in-memory fake in `tests/in-memory-redis-client.ts` instead of spinning up real Redis.

## Operational notes

- **Scheduled reconciliation:** run `resync()` for active wallets on a periodic sweep (and on
  service startup) so drift is caught proactively rather than only on a failed broadcast.
- **NONCE_TOO_LOW / NONCE_TOO_HIGH broadcast errors:** call `resync()` immediately; if it
  throws `NonceReconciliationError`, page a human rather than auto-resolving: see rationale
  above.
- **Wallet tiering:** treasury wallets that rarely transact and hot mint/trading wallets that
  transact frequently share this same manager; no tier-specific behavior is needed here since
  the atomicity guarantees are the same regardless of transaction frequency.

## Testing

```
npm test          # run once
npm run typecheck  # strict TypeScript, no emit
```

The test suite includes a concurrency test that fires 50 simultaneous `getNextNonce` calls for
the same wallet and asserts all 50 nonces are unique and contiguous: the property this whole
package exists to guarantee.
