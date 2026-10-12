#!/usr/bin/env node
/* eslint-disable no-console -- a build script: its output is progress for the person running it. */
/**
 * `npm run build` for the whole monorepo, in dependency order: generate the Prisma client, then build
 * each workspace after the workspaces it depends on. npm's own --workspaces order would build an app
 * before the packages it imports.
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Expands the root `workspaces` globs (only the `dir/*` form is used in this repo). */
function workspaceDirs() {
  return rootPkg.workspaces.flatMap((pattern) => {
    if (!pattern.endsWith('/*')) return [pattern];
    const parent = join(root, pattern.slice(0, -2));
    if (!existsSync(parent)) return [];
    return readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(pattern.slice(0, -2), d.name));
  });
}

const workspaces = workspaceDirs()
  .filter((dir) => existsSync(join(root, dir, 'package.json')))
  .map((dir) => {
    const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies });
    return { dir, name: pkg.name, hasBuild: Boolean(pkg.scripts?.build), deps };
  });

const byName = new Map(workspaces.map((w) => [w.name, w]));
const ordered = [];
const state = new Map(); // name -> 'visiting' | 'done'
function visit(w, trail) {
  if (state.get(w.name) === 'done') return;
  if (state.get(w.name) === 'visiting') throw new Error(`Dependency cycle: ${[...trail, w.name].join(' -> ')}`);
  state.set(w.name, 'visiting');
  for (const dep of w.deps) {
    const target = byName.get(dep);
    if (target) visit(target, [...trail, w.name]);
  }
  state.set(w.name, 'done');
  ordered.push(w);
}
for (const w of workspaces) visit(w, []);

const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

const database = workspaces.find((w) => w.name === '@stryx/database');
if (database) {
  console.log('\n> prisma generate (@stryx/database)');
  run('npx prisma generate', join(root, database.dir));
}

for (const w of ordered.filter((w) => w.hasBuild)) {
  console.log(`\n> build ${w.name}`);
  run('npm run build', join(root, w.dir));
}
console.log(`\nBuilt ${ordered.filter((w) => w.hasBuild).length} workspaces in dependency order.`);
