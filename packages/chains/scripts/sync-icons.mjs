#!/usr/bin/env node
/**
 * Regenerates icons/*.svg from the web3icons project (MIT, github.com/0xa3k5/web3icons).
 *
 * Why a script and not a dependency: @web3icons/core is 17,939 files and about 18 MB
 * for the handful of icons we use, and it ships each SVG as a JS module (an exported string),
 * not a loose .svg. So this packs a PINNED version into a temp dir, reads the string
 * out of each module, and writes plain .svg files that are committed. Nothing about
 * web3icons is installed or loaded at runtime.
 *
 *   npm run sync-icons -w @stryx/chains
 *
 * To add a chain: add its entry to src/index.ts, add its web3icons network name here,
 * run this, commit the new svg. Bump VERSION deliberately, and update ATTRIBUTION.md.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VERSION = '4.0.56';
const VARIANT = 'branded';
// icon file we commit -> network name in @web3icons/core
const ICONS = {
  'ethereum.svg': 'ethereum',
  'base.svg': 'base',
  'arbitrum-one.svg': 'arbitrum-one',
  'optimism.svg': 'optimism',
  'polygon.svg': 'polygon',
  'robinhood.svg': 'robinhood',
  'bnb.svg': 'binance-smart-chain',
  'hyperevm.svg': 'hyper-evm',
  'berachain.svg': 'berachain',
  'monad.svg': 'monad',
  'avalanche.svg': 'avalanche',
  'abstract.svg': 'abstract',
  'ink.svg': 'ink',
  'ronin.svg': 'ronin',
  'arc.svg': 'arc',
};

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'icons');
const tmp = mkdtempSync(join(tmpdir(), 'web3icons-'));

try {
  execFileSync('npm', ['pack', `@web3icons/core@${VERSION}`, '--pack-destination', tmp, '--silent'], { cwd: tmp, stdio: 'inherit' });
  execFileSync('tar', ['xzf', join(tmp, `web3icons-core-${VERSION}.tgz`), '-C', tmp]);
  mkdirSync(outDir, { recursive: true });
  for (const [file, network] of Object.entries(ICONS)) {
    const mod = await import(pathToFileURL(join(tmp, 'package', 'dist', 'svgs', 'networks', VARIANT, `${network}.svg.js`)).href);
    const svg = String(mod.default).trim();
    if (!svg.startsWith('<svg')) throw new Error(`${network}: not an svg`);
    writeFileSync(join(outDir, file), svg + '\n');
    process.stdout.write(`wrote icons/${file} (${svg.length} bytes) from ${network}/${VARIANT}\n`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
