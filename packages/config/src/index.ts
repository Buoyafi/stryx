import { z } from 'zod';

/** An optional URL: an empty string counts as absent. */
const optionalUrl = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().url().optional(),
);

const optionalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().optional(),
);

/** An optional decimal digit string (a wei amount), checked at startup. */
const optionalDecimalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().regex(/^\d+$/, 'must be a plain decimal integer string (wei)').optional(),
);

/** A real boolean: unlike z.coerce.boolean(), the string "false" is false. */
const strictBoolean = (defaultValue: boolean) =>
  z.preprocess((v) => {
    if (typeof v !== 'string' || v.trim() === '') return defaultValue;
    const normalized = v.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return v; // deliberately not coerced: let the boolean schema below reject it with a clear message
  }, z.boolean());

const EnvSchema = z.object({
  // No default: a server that forgot it would quietly run as development, with every production check
  // skipped.
  NODE_ENV: z.enum(['development', 'test', 'production'], {
    error: 'must be set to development, test or production. Add NODE_ENV=development to .env on your own machine, NODE_ENV=production on a server.',
  }),
  PORT: z.coerce.number().int().positive().default(3000),
  // The address the API listens on.
  HOST: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().default('0.0.0.0')),
  DATABASE_URL: z.string().min(1),
  // ADR-002 §3.10: the app's runtime connection, as the lower-privileged `stryx_app` role. It must be
  // a different role from DATABASE_URL, which owns the tables.
  RUNTIME_DATABASE_URL: optionalString,
  KMS_PROVIDER: z.enum(['local', 'aws']).default('local'),
  KMS_KEY_ID: optionalString,
  REDIS_URL: z.string().min(1),
  // Per-chain RPC endpoints. A chain is available for minting only when its RPC URL is set.
  RPC_ROBINHOOD_PRIMARY: optionalUrl,
  RPC_ROBINHOOD_TESTNET: optionalUrl,
  // Testnet chains are available only when this is on, even with their RPC set.
  ENABLE_TESTNETS: z.preprocess((v) => {
    if (typeof v !== 'string' || v.trim() === '') return undefined;
    const n = v.trim().toLowerCase();
    return n === 'true' ? true : n === 'false' ? false : v;
  }, z.boolean().optional()),
  // Optional second endpoint per chain, used when the primary fails at the transport level.
  RPC_ROBINHOOD_FALLBACK: optionalUrl,
  RPC_ROBINHOOD_TESTNET_FALLBACK: optionalUrl,
  RPC_ETHEREUM: optionalUrl,
  RPC_BASE: optionalUrl,
  RPC_ARBITRUM: optionalUrl,
  RPC_OPTIMISM: optionalUrl,
  RPC_POLYGON: optionalUrl,
  RPC_ETHEREUM_FALLBACK: optionalUrl,
  RPC_BASE_FALLBACK: optionalUrl,
  RPC_ARBITRUM_FALLBACK: optionalUrl,
  RPC_OPTIMISM_FALLBACK: optionalUrl,
  RPC_POLYGON_FALLBACK: optionalUrl,
  RPC_BNB: optionalUrl,
  RPC_BNB_FALLBACK: optionalUrl,
  RPC_HYPEREVM: optionalUrl,
  RPC_HYPEREVM_FALLBACK: optionalUrl,
  RPC_BERACHAIN: optionalUrl,
  RPC_BERACHAIN_FALLBACK: optionalUrl,
  RPC_MONAD: optionalUrl,
  RPC_MONAD_FALLBACK: optionalUrl,
  RPC_AVALANCHE: optionalUrl,
  RPC_AVALANCHE_FALLBACK: optionalUrl,
  RPC_ABSTRACT: optionalUrl,
  RPC_ABSTRACT_FALLBACK: optionalUrl,
  RPC_INK: optionalUrl,
  RPC_INK_FALLBACK: optionalUrl,
  RPC_RONIN: optionalUrl,
  RPC_RONIN_FALLBACK: optionalUrl,
  RPC_ARC: optionalUrl,
  RPC_ARC_FALLBACK: optionalUrl,

  // OpenSea API v2 key, for resolving a URL or slug to a contract.
  OPENSEA_API_KEY: optionalString,

  // Optional CoinGecko demo API key, for native-token USD prices.
  COINGECKO_API_KEY: optionalString,

  // The shared operator token (`Authorization: Bearer <token>`). Optional here so tests can run
  // without it; server.ts refuses to start without it.
  API_AUTH_TOKEN: optionalString,
  // The read-only `stryx_analytics` role the operator Overview's queries use (ADR-003 §4.11).
  ANALYTICS_DATABASE_URL: optionalString,
  // What that token may do (ADR-003 §4.10): 'admin' = everything (development default), 'api' = act as
  // the operator but never pass an admin check, 'off' = not accepted (production default).
  OPERATOR_TOKEN_MODE: z.enum(['admin', 'api', 'off']).optional(),

  // ADR-002 §3.7: the default daily spend cap in wei, for any user without their own. Unset: a
  // conservative built-in default applies.
  DEFAULT_DAILY_SPEND_CAP_WEI: optionalDecimalString,
  // Per-chain daily caps for capped accounts, each in that chain's own token:
  // "56=2,137=5000,5042=500". ETH chains fall back to DEFAULT_DAILY_SPEND_CAP_WEI; any other chain not
  // listed is 0.
  DEFAULT_DAILY_SPEND_CAPS: optionalString,
  // The share (percent) of an account's daily cap that any one wallet may spend. 1 to 100; blank means
  // 50; 100 turns the wallet limit off.
  WALLET_DAILY_SPEND_SHARE_PERCENT: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.coerce.number().int().min(1).max(100).default(50),
  ),

  // Wallet import accepts a raw private key in the request body, and the API cannot tell from inside
  // whether TLS sits in front of it. The operator declares it; production refuses to start while this
  // is false.
  TLS_TERMINATED: strictBoolean(false),

  // Whether POST /auth/signup is open. Off by default so a fresh deploy starts closed; signing in to
  // existing accounts is unaffected.
  SIGNUP_ENABLED: strictBoolean(false),

  // Eligibility checks for signed allow-list stages.
  OPENSEA_SIGNED_MINT_ELIGIBILITY_ENABLED: strictBoolean(false),

  // The kill switch for signed-mint execution. Off by default. Checked at scheduling, at warm-up and
  // before every wallet's send. For a stop that needs no restart, use the emergency stop.
  SIGNED_MINT_EXECUTION_ENABLED: strictBoolean(false),
  // The API refuses to start when the database is missing a migration this build ships with.
  ALLOW_PENDING_MIGRATIONS: strictBoolean(false),
  // How often a wallet re-asks OpenSea's mint endpoint while it still answers "not active".
  SIGNED_MINT_RETRY_INTERVAL_MS: z.coerce.number().int().min(50).max(5_000).default(250),
  // How long after T-0 a wallet keeps asking before the job gives up on it and reports.
  SIGNED_MINT_GIVE_UP_MS: z.coerce.number().int().min(5_000).max(600_000).default(60_000),
  // At most this many requests to OpenSea's mint endpoint in flight at once, across a job.
  SIGNED_MINT_OPENSEA_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
  // Around T-0 a wallet sends a new request every this many ms without waiting for the last answer. 0
  // turns it off.
  SIGNED_MINT_OVERLAP_MS: z.coerce.number().int().min(0).max(2_000).default(200),
  // At most this many of one wallet's requests in flight while overlapping.
  SIGNED_MINT_MAX_IN_FLIGHT: z.coerce.number().int().min(1).max(6).default(3),
  // Unlock each wallet's key at warm-up and hold its data key in memory until the wallet has sent,
  // instead of one KMS round trip at signing time. Off by default: an unlocked key sits in memory for
  // about a minute per job.
  SIGNED_MINT_HOLD_KEYS: strictBoolean(false),
  // With a primary and a fallback RPC set, send every signed transaction to both and take whichever
  // accepts first.
  RPC_RACE_BROADCAST: strictBoolean(true),

  // Wallet sign-in and invite codes (ADR-003 §4.1). APP_ORIGIN is the dashboard's exact origin, e.g.
  // https://app.example.com. Setting it turns wallet sign-in on. Several may be listed,
  // comma-separated; the first is the main one.
  APP_ORIGIN: optionalString,
  // The secret invite codes are hashed with (HMAC-SHA256). At least 32 characters; required when
  // APP_ORIGIN is set. Changing it makes every unused code stop working.
  ACCESS_CODE_SECRET: optionalString,
  // Terms acceptance (docs/legal). Set both to the versions users must have accepted, e.g. "1.0".
  // Unset: nothing is asked or enforced.
  TERMS_VERSION: optionalString,
  PRIVACY_VERSION: optionalString,
  // Waitlist invites by email, sent through Resend. Set RESEND_API_KEY to turn it on; it also needs
  // APP_ORIGIN.
  RESEND_API_KEY: optionalString,
  INVITE_EMAIL_FROM: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().default('Stryx <invites@gostryx.com>')),
  INVITE_EMAIL_REPLY_TO: optionalString,
  SITE_URL: optionalString,
  // Behind a reverse proxy: how many proxies you control sit in front of the API. The visitor's
  // address is read that many entries from the end of X-Forwarded-For. Unset or "false": the header is
  // ignored.
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v, ctx) => {
      const raw = (v ?? '').trim().toLowerCase();
      if (raw === '' || raw === 'false' || raw === '0') return 0;
      if (raw === 'true') return 1;
      const hops = Number(raw);
      if (Number.isInteger(hops) && hops >= 1 && hops <= 5) return hops;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'TRUST_PROXY must be true, false, or the number of proxies in front of the API (1 to 5)' });
      return z.NEVER;
    }),
});

export type AppConfig = z.infer<typeof EnvSchema>;

let cachedConfig: AppConfig | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cachedConfig) return cachedConfig;

  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  if (result.data.KMS_PROVIDER === 'aws' && !result.data.KMS_KEY_ID) {
    throw new Error('KMS_KEY_ID is required when KMS_PROVIDER=aws');
  }
  if (result.data.KMS_PROVIDER === 'local' && result.data.NODE_ENV === 'production') {
    throw new Error(
      'KMS_PROVIDER=local is not permitted when NODE_ENV=production: see ADR-001. Set KMS_PROVIDER=aws and KMS_KEY_ID.',
    );
  }
  if (result.data.NODE_ENV === 'production' && !result.data.TLS_TERMINATED) {
    throw new Error(
      'TLS_TERMINATED is not set to true, but NODE_ENV=production. Wallet import (POST /wallets/import) ' +
        'accepts a raw private key in the request body: over plain HTTP that key is readable in transit ' +
        'by anything on the network path. Refusing to start until TLS is confirmed terminated in front of ' +
        'this service. Set TLS_TERMINATED=true only once a real TLS-terminating proxy/load balancer is ' +
        'actually in place: this process cannot verify that for itself.',
    );
  }

  if (result.data.APP_ORIGIN) {
    for (const raw of result.data.APP_ORIGIN.split(',').map((s) => s.trim())) {
      let origin: URL;
      try {
        origin = new URL(raw);
      } catch {
        throw new Error('APP_ORIGIN must be a full origin such as https://app.stryx.xyz (several may be listed, comma-separated)');
      }
      if (origin.origin !== raw.replace(/\/$/, '')) {
        throw new Error(`APP_ORIGIN must be an origin only (scheme, host, optional port), with no path: got ${raw}`);
      }
      if (result.data.NODE_ENV === 'production' && origin.protocol !== 'https:') {
        throw new Error('APP_ORIGIN must use https when NODE_ENV=production: the session cookie is only sent over TLS.');
      }
    }
    if (!result.data.ACCESS_CODE_SECRET || result.data.ACCESS_CODE_SECRET.length < 32) {
      throw new Error('ACCESS_CODE_SECRET (at least 32 characters) is required when APP_ORIGIN is set: invite codes are hashed with it.');
    }
  }

  const { TERMS_VERSION: termsVersion, PRIVACY_VERSION: privacyVersion } = result.data;
  if (Boolean(termsVersion) !== Boolean(privacyVersion)) {
    throw new Error('TERMS_VERSION and PRIVACY_VERSION must be set together (or both left unset to turn terms acceptance off).');
  }
  for (const v of [termsVersion, privacyVersion]) {
    if (v && !/^[A-Za-z0-9._-]{1,32}$/.test(v)) {
      throw new Error('TERMS_VERSION and PRIVACY_VERSION may only contain letters, digits, dots, dashes and underscores (32 characters at most).');
    }
  }

  cachedConfig = result.data;
  return cachedConfig;
}

/** The dashboard origins APP_ORIGIN lists, main one first ([] when wallet sign-in is off). */
export function appOrigins(config: Pick<AppConfig, 'APP_ORIGIN'>): string[] {
  if (!config.APP_ORIGIN) return [];
  return config.APP_ORIGIN.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new URL(s).origin);
}

export function resetConfigCacheForTests(): void {
  cachedConfig = undefined;
}

/** Whether testnet chains are offered: ENABLE_TESTNETS when set, else on everywhere but production. */
export function testnetsEnabled(config: Pick<AppConfig, 'ENABLE_TESTNETS' | 'NODE_ENV'>): boolean {
  return config.ENABLE_TESTNETS ?? config.NODE_ENV !== 'production';
}
