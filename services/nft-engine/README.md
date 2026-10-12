# @stryx/nft-engine: SeaDrop module

Mint support for OpenSea Drops (FCFS/allow-list phases + public mint). Confirmed against the
real, deployed SeaDrop contract source (ProjectOpenSea/seadrop): the ABI here isn't guessed,
every field name, type, and struct layout is taken directly from `ISeaDrop.sol` and
`SeaDropStructs.sol`, and the transaction-builder tests round-trip decode the calldata to prove
it matches.

## Why this needed no OpenSea API integration

OpenSea Drops run on SeaDrop, OpenSea's own open-source drop protocol, deployed at the same
address (`0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`) on every chain it supports. Minting is a
direct on-chain contract call, same as any other mint contract this platform targets. No API
key, no OpenSea-specific auth, no rate limits to work around for the mint itself.

## What's here

- **`types/seadrop.types.ts`**: `PublicDrop` and `MintParams`, matching the on-chain struct
  layout exactly (field order matters: it's part of how the contract validates `mintParams`).
- **`utils/seadrop-abi.ts`**: the canonical SeaDrop address and a partial ABI covering only
  `mintPublic`, `mintAllowList`, and the read functions needed to know current drop state.
- **`service/seadrop-reader.service.ts`**: `SeaDropReader`, reads live on-chain state
  (`getPublicDrop`, `getAllowListMerkleRoot`, `getAllowedFeeRecipients`). Always read fresh
  immediately before building a mint tx: never cache across a mint attempt, since a stale read
  is exactly how you'd submit at the wrong price or against an ended stage.
- **`service/seadrop-tx-builder.service.ts`**: `SeaDropTransactionBuilder`, builds the exact
  `{ to, data, value }` for a mint. Deliberately unsigned/unbroadcast: hands off to the
  existing pipeline from here.
- **`service/seadrop-contract-scanner.service.ts`**: `SeaDropContractScanner`, detects whether
  a candidate contract has a live/registered SeaDrop drop. See "On contract detection" below for
  why this doesn't use the obvious ERC165 approach.

## On contract detection

The textbook way to detect a SeaDrop token is checking
`supportsInterface(type(INonFungibleSeaDropToken).interfaceId)` via ERC165. That interface ID is
the XOR of every function selector SeaDrop's interface declares, computed by the Solidity
compiler at build time: it isn't published anywhere as a verifiable constant, and hand-deriving
it risks a bug that fails *silently* (detection just always returns false, no error to notice).

Instead, `SeaDropContractScanner` asks **SeaDrop itself** whether a candidate address has a
drop registered: reading `getPublicDrop()` / `getAllowListMerkleRoot()` for that address. This
only depends on the ABI already proven correct by the round-trip-decode tests above, and it's
arguably the more useful signal anyway: a contract that technically implements the interface but
has no drop configured isn't mintable regardless. ERC721/ERC165 checks are included as
supplementary sanity signals, not as the detection mechanism itself.


## How this plugs into the rest of the platform

```
SeaDropReader.isPublicStageActive() / getPublicDrop()
        │
        ▼
strategy-engine decides: mint or don't (reuses the existing declarative rule model)
        │
        ▼
SeaDropTransactionBuilder.buildMintPublicTx() / buildMintAllowListTx()
        │
        ▼
transaction-engine: simulate → @stryx/nonce-manager for the nonce →
  @stryx/wallet-service (which calls @stryx/key-management) to sign → broadcast
```

For allow-list (FCFS presale) mints, the Merkle `proof` argument comes from
`workers/eligibility`: this package
only consumes a proof, it doesn't generate one.

## Two things worth knowing before wiring this into a live strategy

1. **`mintParams` must match the on-chain stage exactly.** The contract hashes `mintParams` and
   checks it against what's actually configured for that stage: a mismatched field (wrong
   `dropStageIndex`, stale `mintPrice`) is a straight revert, not a wrong-price mint. Always
   source `mintParams` from a fresh read, never hardcode or cache it.
2. **`feeRecipient` isn't arbitrary.** SeaDrop splits payment between OpenSea's fee address and
   the collection creator: call `getAllowedFeeRecipients()` and use one of the returned
   addresses, don't guess or hardcode one.

## Testing

```
npm test         # 9 tests: PublicDrop/MintParams parsing, stage-active timing logic,
                  # and calldata round-trip decode against the real ABI
npm run typecheck
```

The two "encodes ... calldata that decodes back to the exact input arguments" tests are the
ones that matter most if you're modifying the ABI or builder: they're what actually prove the
encoding is contract-correct, not just that the code runs without throwing.
