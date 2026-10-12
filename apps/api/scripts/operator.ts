/** Operator account administration (ADR-003 §4.10). */
/* eslint-disable no-console -- a CLI: printing the result is its whole job. */
import 'dotenv/config';
import { loadConfig } from '@stryx/config';
import { getPrismaClient, disconnectPrisma } from '@stryx/database';
import { adoptWallet, capAccount, describeAdmins, grantAdmin, prismaOperatorAdminStore, revokeAdmin, uncapAccount, type OperatorResult } from '../src/operator-admin.js';

const USAGE = 'Usage: operator.ts adopt|grant|revoke|uncap|cap <0xAddress>, or operator.ts list';

/** Prisma's errors open with where the call was ("Invalid `users.findMany()` invocation") and end with why: show the why. */
function failureReason(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const why = lines[lines.length - 1] ?? text;
  if (/authentication failed|valid database credentials/i.test(why)) return `${why} Check the user and password in DATABASE_URL.`;
  if (/Can't reach database server/i.test(why)) return `${why} Is Postgres running, and is DATABASE_URL's host and port right?`;
  return why;
}

async function main(): Promise<number> {
  const [command, address] = process.argv.slice(2);
  const config = loadConfig();
  if (!config.DATABASE_URL) {
    console.error('DATABASE_URL is not set. These scripts run with the migration role, not the app role.');
    return 1;
  }
  const store = prismaOperatorAdminStore(getPrismaClient(config.DATABASE_URL));
  let result: OperatorResult;
  try {
    switch (command) {
      case 'adopt':
        result = await adoptWallet(store, address);
        break;
      case 'grant':
        result = await grantAdmin(store, address);
        break;
      case 'revoke':
        result = await revokeAdmin(store, address, {
          // The same default the server uses (server.ts).
          tokenIsAdmin: (config.OPERATOR_TOKEN_MODE ?? (config.NODE_ENV === 'production' ? 'off' : 'admin')) === 'admin',
        });
        break;
      case 'uncap':
        result = await uncapAccount(store, address);
        break;
      case 'cap':
        result = await capAccount(store, address);
        break;
      case 'list':
        result = await describeAdmins(store);
        break;
      default:
        result = { ok: false, message: USAGE };
    }
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    result = {
      ok: false,
      message: /cannot change a role|permission denied/i.test(text)
        ? 'The database refused: this connection is the app role. Run it with DATABASE_URL set to the migration role.'
        : `Failed: ${failureReason(text)}`,
    };
  } finally {
    await disconnectPrisma();
  }
  (result.ok ? console.log : console.error)(result.message);
  return result.ok ? 0 : 1;
}

main().then((code) => process.exit(code));
