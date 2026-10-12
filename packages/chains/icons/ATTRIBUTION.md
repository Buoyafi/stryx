# Chain icon attribution

The SVG files in this folder come from the web3icons project.

- Project: https://github.com/0xa3k5/web3icons (site: https://web3icons.io)
- npm package: `@web3icons/core`, version **4.0.56** (pinned in `scripts/sync-icons.mjs`)
- Variant used: `branded` (each network in its own colours)
- Licence of the project: MIT, copyright its contributors. The licence text is at
  https://github.com/0xa3k5/web3icons/blob/main/LICENSE

The files here are regenerated, not hand-edited: `npm run sync-icons -w @stryx/chains`.

| File | web3icons network | Used for |
| --- | --- | --- |
| `ethereum.svg` | `ethereum` | Ethereum |
| `base.svg` | `base` | Base |
| `arbitrum-one.svg` | `arbitrum-one` | Arbitrum One |
| `optimism.svg` | `optimism` | Optimism |
| `polygon.svg` | `polygon` | Polygon |
| `robinhood.svg` | `robinhood` | Robinhood Chain and Robinhood Chain Testnet |
| `bnb.svg` | `binance-smart-chain` | BNB Chain |
| `hyperevm.svg` | `hyper-evm` | HyperEVM |
| `berachain.svg` | `berachain` | Berachain |
| `monad.svg` | `monad` | Monad |
| `avalanche.svg` | `avalanche` | Avalanche |
| `abstract.svg` | `abstract` | Abstract |
| `ink.svg` | `ink` | Ink |
| `ronin.svg` | `ronin` | Ronin |
| `arc.svg` | `arc` | Arc (Circle) |

Each web3icons network was matched to our chain by the chain id in web3icons' own metadata
(`@web3icons/common`), not by name alone: 56, 999, 80094, 143, 43114, 2741, 57073, 2020. Its
`arc` entry is Circle's Arc (listed with the testnet id 5042002 and native USDC); same brand.

## Trademarks

The MIT licence covers the web3icons collection. The logos themselves remain the
trademarks of their respective owners and are shown only to identify the chains they
belong to. If a chain's owner supplies an official brand-kit file, replace the file
here (and this table) with it.

## Colours

The fill colours inside these files are the chains' own brand colours. They are asset
content, not styling: no component or stylesheet in this repo references them.
