import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkMigrations, shippedMigrations, MIGRATIONS_DIR } from '@stryx/database';
import { migrationGate } from '../src/migration-gate.js';

function folder(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'stryx-migrations-'));
  for (const n of names) mkdirSync(join(dir, n));
  return dir;
}
const db = (rows: string[] | Error) => ({
  $queryRawUnsafe: async <T>() => {
    if (rows instanceof Error) throw rows;
    return rows.map((migration_name) => ({ migration_name })) as T;
  },
});
const A = '20260901000000_a';
const B = '20260902000000_b';
const C = '20260903000000_c';

describe('the startup migration check', () => {
  it('finds the real migrations folder that ships with the database package', () => {
    const names = shippedMigrations(MIGRATIONS_DIR)!;
    expect(names.length).toBeGreaterThan(10);
    expect(names).toContain('20261001120000_app_reads_migration_history');
    expect([...names].sort()).toEqual(names);
  });

  it('is ok when every shipped migration is applied (extra ones from a newer build are fine)', async () => {
    expect(await checkMigrations(db([A, B, C, '20991231000000_newer']), folder([A, B, C]))).toEqual({ status: 'ok', applied: 4 });
  });

  it('names exactly the migrations the database is missing', async () => {
    expect(await checkMigrations(db([A]), folder([A, B, C]))).toEqual({ status: 'behind', pending: [B, C] });
  });

  it('a database never migrated is missing everything', async () => {
    expect(await checkMigrations(db(new Error('relation "_prisma_migrations" does not exist')), folder([A, B]))).toEqual({ status: 'behind', pending: [A, B] });
  });

  it('cannot tell when it may not read the table (the grant migration itself is missing)', async () => {
    const check = await checkMigrations(db(new Error('permission denied for table _prisma_migrations\nmore')), folder([A]));
    expect(check).toEqual({ status: 'unknown', reason: 'permission denied for table _prisma_migrations' });
  });

  it('with no migrations folder there is nothing to compare', async () => {
    expect(await checkMigrations(db([A]), join(tmpdir(), 'definitely-not-here-' + Date.now()))).toEqual({ status: 'no_folder' });
  });
});

describe('what startup does with it', () => {
  it('starts when up to date, and refuses with the fix when behind or unknown', () => {
    expect(migrationGate({ status: 'ok', applied: 3 }, false)).toMatchObject({ start: true, level: 'info' });
    const behind = migrationGate({ status: 'behind', pending: [B, C] }, false);
    expect(behind).toMatchObject({ start: false, level: 'error' });
    expect(behind.message).toContain(`missing 2 migrations: ${B}, ${C}`);
    expect(behind.message).toContain('npx prisma migrate deploy');
    expect(migrationGate({ status: 'unknown', reason: 'permission denied' }, false)).toMatchObject({ start: false, level: 'error' });
  });

  it('starts anyway, with a warning, only when ALLOW_PENDING_MIGRATIONS is set', () => {
    const gate = migrationGate({ status: 'behind', pending: [B] }, true);
    expect(gate).toMatchObject({ start: true, level: 'warn' });
    expect(gate.message).toContain('Starting anyway');
    expect(migrationGate({ status: 'no_folder' }, false)).toMatchObject({ start: true, level: 'warn' });
  });
});
