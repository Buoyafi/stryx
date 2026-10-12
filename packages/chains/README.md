# @stryx/chains

The central chain registry: for every chain Stryx knows about, its id, name,
mainnet or testnet, gas token and icon. Pure data (no Node or browser APIs), so
the API, the operator dashboard and the public landing page all read the same table.

```ts
import { CHAINS, chainById, networkLabel } from '@stryx/chains';
```

- `src/index.ts` is the table. Add a chain here first.
- `icons/` holds the committed SVG files the `icon` field points at. They are
  regenerated from a pinned web3icons release by `npm run sync-icons`; see
  `icons/ATTRIBUTION.md`. A chain with `icon: null` gets a lettered fallback badge.
- Anything deployment-specific (an RPC URL, the env var that carries it) does not
  belong here. `apps/api/src/chain-registry.ts` maps every `KnownChainId` to its
  RPC env key, and fails to compile if one is missing.

Like the other packages this builds to `dist/` (`npm run build`), and apps consume
`dist`, so rebuild after changing it.
