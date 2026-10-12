import { PrismaClient } from '@prisma/client';

let client: PrismaClient | undefined;

/**
 * `url` overrides the schema's DATABASE_URL for this client, so the app can connect as a
 * lower-privileged role than migrations use (ADR-002 §3.10).
 */
export function getPrismaClient(url?: string): PrismaClient {
  if (!client) {
    client = url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient();
  }
  return client;
}

/**
 * A separate client on its own connection, for a second database role alongside the main one (the
 * read-only analytics role, ADR-003 §4.11).
 */
export function createPrismaClient(url: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } } });
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}

export type { PrismaClient, Prisma } from '@prisma/client';
export { checkMigrations, shippedMigrations, MIGRATIONS_DIR, type MigrationCheck } from './migration-check.js';
