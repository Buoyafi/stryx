import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This package's migrations folder (the same from src/ under tsx and from dist/ when built). */
export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../prisma/migrations');

/** The migrations shipped with this build, oldest first. Null when the folder is not there to read. */
export function shippedMigrations(dir: string = MIGRATIONS_DIR): string[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
}

export type MigrationCheck =
  | { status: 'ok'; applied: number }
  /** Shipped with this build but not applied to the database. */
  | { status: 'behind'; pending: string[] }
  /** The database could not say (no migration table, or no permission to read it): treat as behind. */
  | { status: 'unknown'; reason: string }
  /** No migrations folder next to this build: nothing to compare against. */
  | { status: 'no_folder' };

interface RawQuery {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
}

/** Compares the migrations shipped with this build to the ones the database has applied. */
export async function checkMigrations(prisma: RawQuery, dir: string = MIGRATIONS_DIR): Promise<MigrationCheck> {
  const shipped = shippedMigrations(dir);
  if (!shipped) return { status: 'no_folder' };
  let applied: Set<string>;
  try {
    const rows = await prisma.$queryRawUnsafe<{ migration_name: string }[]>(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    applied = new Set(rows.map((r) => r.migration_name));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/does not exist/i.test(message)) return { status: 'behind', pending: shipped };
    return { status: 'unknown', reason: message.split('\n').find((l) => l.trim()) ?? message };
  }
  const pending = shipped.filter((name) => !applied.has(name));
  return pending.length > 0 ? { status: 'behind', pending } : { status: 'ok', applied: applied.size };
}
