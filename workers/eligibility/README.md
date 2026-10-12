# @stryx/eligibility

Merkle proof generation and verification for SeaDrop allow-list (presale/FCFS) mint stages.

## The bug this package's own tests caught before it ever shipped

The first version of this package used `@openzeppelin/merkle-tree`: OZ's official tree
library: to build allow-list trees. That library double-hashes its leaves
(`keccak256(keccak256(...))`) as its own defense-in-depth convention. SeaDrop's actual on-chain
contract does a **single** hash: `keccak256(abi.encode(minter, mintParams))`, confirmed directly
against `SeaDrop.sol` source. Two different leaf conventions produce two completely different
roots for the same data, meaning every proof from that first version would have verified
locally but reverted on-chain, 100% of the time, against a real drop.

This was caught by this package's own "independent cross-check" tests: a hand-written proof
verifier (`verifyMerkleProof`, `merkle-verify.util.ts`) that shares no code with whatever built
the tree, checking the tree's own output against itself. When those tests failed, it meant the
library and the verifier disagreed, which is exactly the class of bug worth finding in a test
suite, not in a reverted mint transaction with real gas spent. The fix was dropping the library
entirely and building the tree from scratch using only the two primitives independently verified
against `SeaDrop.sol`.

## What's here

- **`utils/merkle-verify.util.ts`**: `computeAllowListLeafHash` (verified against
  `SeaDrop.sol`'s `_mintAllowList`) and `verifyMerkleProof` / `hashPair` (verified against
  OpenZeppelin's `MerkleProof.sol` sorted-pair algorithm, which SeaDrop's contract calls into).
  These two functions are the entire cryptographic foundation everything else is built on.
- **`service/seadrop-allowlist-tree.service.ts`**: `SeaDropAllowListTree`, builds a tree from
  a list of `(minter, mintParams)` entries using only the primitives above. **Read the caveat in
  its doc comment** about odd-node handling and matching a creator's original tree construction.
- **`service/eligibility-checker.service.ts`**: `EligibilityChecker`, the main entry point.
  Two ways to use it:
  - `checkEligibility(tree, onChainRoot, minter)`: reconstructs from raw entries you provide.
  - `verifyGivenProof(minter, mintParams, proof, onChainRoot)`: verifies a proof that came from
    somewhere else (the creator's own published `allowListURI`, or a proof-lookup API they
    host). **Prefer this path whenever the creator's own proof data is obtainable**: it depends
    only on the two verified primitives, with zero assumption about how their tree was built.

## The safety check that matters most: root mismatch

`checkEligibility` always compares the locally-built tree's root against the **live on-chain**
root (from `@stryx/nft-engine`'s `SeaDropReader.getAllowListMerkleRoot`) before anything else. A
locally-held allow-list can be stale, wrong, or for the wrong contract/stage entirely: this
check fails closed (`root_mismatch`) rather than ever returning a false "eligible."

## Testing

```
npm test         # 14 tests: leaf-hash determinism, multi-entry proof generation and
                  # independent verification, root-mismatch-checked-before-membership,
                  # dump/load round-trip
npm run typecheck
```

The tests under "independent cross-check" in `merkle-tree.test.ts` are the most important ones
in this package: they're what actually caught the OZ double-hash issue above, and they're what
would catch a similar regression in the future.
