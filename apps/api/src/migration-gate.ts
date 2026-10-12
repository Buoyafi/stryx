import type { MigrationCheck } from '@stryx/database';

/**
 * What startup does with the migration check: start, or refuse with one clear message naming what is
 * missing and the command that fixes it.
 */
export function migrationGate(check: MigrationCheck, allowPending: boolean): { start: boolean; level: 'info' | 'warn' | 'error'; message: string } {
  const fix = 'Run: cd packages/database && npx prisma migrate deploy (with DATABASE_URL set to the migration role), then start the API again.';
  switch (check.status) {
    case 'ok':
      return { start: true, level: 'info', message: `database migrations up to date (${check.applied} applied)` };
    case 'no_folder':
      return { start: true, level: 'warn', message: 'no migrations folder found next to this build, so the database was not checked' };
    case 'behind': {
      const list = check.pending.join(', ');
      const message = `the database is missing ${check.pending.length} migration${check.pending.length === 1 ? '' : 's'}: ${list}. ${fix}`;
      return allowPending ? { start: true, level: 'warn', message: `${message} Starting anyway (ALLOW_PENDING_MIGRATIONS=true).` } : { start: false, level: 'error', message };
    }
    case 'unknown': {
      const message = `could not check the database migrations (${check.reason}). The database is probably behind this build. ${fix}`;
      return allowPending ? { start: true, level: 'warn', message: `${message} Starting anyway (ALLOW_PENDING_MIGRATIONS=true).` } : { start: false, level: 'error', message };
    }
  }
}
