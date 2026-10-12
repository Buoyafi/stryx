import { describe, expect, it } from 'vitest';
import { appOrigins, loadConfig, resetConfigCacheForTests, testnetsEnabled } from '../src/index.js';

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadConfig: NODE_ENV is never guessed', () => {
  const { NODE_ENV: _omitted, ...withoutNodeEnv } = base;

  it('refuses to start without it, and says what to set', () => {
    resetConfigCacheForTests();
    expect(() => loadConfig({ ...withoutNodeEnv } as NodeJS.ProcessEnv)).toThrow(/NODE_ENV: must be set to development, test or production/);
  });

  it('refuses a blank or unknown value the same way', () => {
    for (const value of ['', 'prod', 'Production']) {
      resetConfigCacheForTests();
      expect(() => loadConfig({ ...withoutNodeEnv, NODE_ENV: value } as NodeJS.ProcessEnv)).toThrow(/NODE_ENV: must be set to/);
    }
  });

  it('a missing value can no longer skip the production checks', () => {
    // Before: this loaded as development and started with the local key provider.
    resetConfigCacheForTests();
    expect(() => loadConfig({ ...withoutNodeEnv, KMS_PROVIDER: 'local' } as NodeJS.ProcessEnv)).toThrow(/NODE_ENV/);
  });
});

describe('loadConfig: TRUST_PROXY is a number of proxies, never "trust the whole header"', () => {
  const hops = (value?: string) => {
    resetConfigCacheForTests();
    return loadConfig({ ...base, ...(value === undefined ? {} : { TRUST_PROXY: value }) } as NodeJS.ProcessEnv).TRUST_PROXY;
  };

  it('is off when unset, blank, false or 0', () => {
    for (const value of [undefined, '', 'false', 'FALSE', '0']) expect(hops(value)).toBe(0);
  });

  it('"true" means one proxy, and a number means that many', () => {
    expect(hops('true')).toBe(1);
    expect(hops('1')).toBe(1);
    expect(hops('2')).toBe(2);
  });

  it('refuses anything else, with what to write instead', () => {
    for (const value of ['yes', '-1', '6', '1.5', '10.0.0.0/8']) {
      resetConfigCacheForTests();
      expect(() => loadConfig({ ...base, TRUST_PROXY: value } as NodeJS.ProcessEnv), value).toThrow(/TRUST_PROXY must be true, false, or the number of proxies/);
    }
  });
});

describe('loadConfig: optional URL/string handling', () => {
  it('treats a blank RPC line as absent (does not crash)', () => {
    resetConfigCacheForTests();
    const config = loadConfig({ ...base, RPC_ETHEREUM: '', RPC_BASE: '   ' } as NodeJS.ProcessEnv);
    expect(config.RPC_ETHEREUM).toBeUndefined();
    expect(config.RPC_BASE).toBeUndefined();
  });

  it('accepts a valid RPC url', () => {
    resetConfigCacheForTests();
    const config = loadConfig({ ...base, RPC_ETHEREUM: 'https://eth.example.com' } as NodeJS.ProcessEnv);
    expect(config.RPC_ETHEREUM).toBe('https://eth.example.com');
  });

  it('still rejects a non-empty but malformed RPC url', () => {
    resetConfigCacheForTests();
    expect(() => loadConfig({ ...base, RPC_ETHEREUM: 'not-a-url' } as NodeJS.ProcessEnv)).toThrow();
  });

  it('treats blank optional string keys as absent', () => {
    resetConfigCacheForTests();
    const config = loadConfig({ ...base, OPENSEA_API_KEY: '', KMS_KEY_ID: '' } as NodeJS.ProcessEnv);
    expect(config.OPENSEA_API_KEY).toBeUndefined();
    expect(config.KMS_KEY_ID).toBeUndefined();
  });

  it('still fails when a required field is missing', () => {
    resetConfigCacheForTests();
    expect(() => loadConfig({ REDIS_URL: 'redis://localhost:6379' } as NodeJS.ProcessEnv)).toThrow();
  });

  it('accepts the per-chain RPC fallback vars, same optional-URL handling as their primaries', () => {
    resetConfigCacheForTests();
    const config = loadConfig({
      ...base,
      RPC_ROBINHOOD_FALLBACK: 'https://fallback.example.com',
      RPC_ROBINHOOD_TESTNET_FALLBACK: '',
    } as NodeJS.ProcessEnv);
    expect(config.RPC_ROBINHOOD_FALLBACK).toBe('https://fallback.example.com');
    expect(config.RPC_ROBINHOOD_TESTNET_FALLBACK).toBeUndefined();
  });
});

describe('loadConfig: OPENSEA_SIGNED_MINT_ELIGIBILITY_ENABLED (closed by default)', () => {
  it('defaults to false', () => {
    resetConfigCacheForTests();
    const config = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(config.OPENSEA_SIGNED_MINT_ELIGIBILITY_ENABLED).toBe(false);
  });

  it('the literal string "false" stays false (not coerced to true by JS truthiness)', () => {
    resetConfigCacheForTests();
    const config = loadConfig({ ...base, OPENSEA_SIGNED_MINT_ELIGIBILITY_ENABLED: 'false' } as NodeJS.ProcessEnv);
    expect(config.OPENSEA_SIGNED_MINT_ELIGIBILITY_ENABLED).toBe(false);
  });

  it('turns on only with the literal string "true"', () => {
    resetConfigCacheForTests();
    const config = loadConfig({ ...base, OPENSEA_SIGNED_MINT_ELIGIBILITY_ENABLED: 'true' } as NodeJS.ProcessEnv);
    expect(config.OPENSEA_SIGNED_MINT_ELIGIBILITY_ENABLED).toBe(true);
  });
});

describe('loadConfig: RUNTIME_DATABASE_URL (ADR-002 §3.10)', () => {
  it('is undefined when absent (caller falls back to DATABASE_URL)', () => {
    resetConfigCacheForTests();
    const config = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(config.RUNTIME_DATABASE_URL).toBeUndefined();
  });

  it('accepts a distinct connection string when configured', () => {
    resetConfigCacheForTests();
    const config = loadConfig({
      ...base,
      RUNTIME_DATABASE_URL: 'postgresql://stryx_app:x@localhost:5432/stryx',
    } as NodeJS.ProcessEnv);
    expect(config.RUNTIME_DATABASE_URL).toBe('postgresql://stryx_app:x@localhost:5432/stryx');
  });
});

describe('loadConfig: DEFAULT_DAILY_SPEND_CAP_WEI (ADR-002 §3.7)', () => {
  it('is undefined when absent (falls back to the hardcoded default elsewhere)', () => {
    resetConfigCacheForTests();
    const config = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(config.DEFAULT_DAILY_SPEND_CAP_WEI).toBeUndefined();
  });

  it('accepts a plain decimal wei string', () => {
    resetConfigCacheForTests();
    const config = loadConfig({ ...base, DEFAULT_DAILY_SPEND_CAP_WEI: '5000000000000000000' } as NodeJS.ProcessEnv);
    expect(config.DEFAULT_DAILY_SPEND_CAP_WEI).toBe('5000000000000000000');
  });

  it('fails loud at startup on a malformed value, rather than throwing deep inside a request', () => {
    resetConfigCacheForTests();
    expect(() =>
      loadConfig({ ...base, DEFAULT_DAILY_SPEND_CAP_WEI: '5 ETH' } as NodeJS.ProcessEnv),
    ).toThrow(/must be a plain decimal integer string/);
  });
});

describe('loadConfig: KMS production guard (ADR-002 §3.8)', () => {
  it('refuses KMS_PROVIDER=local when NODE_ENV=production: LOCAL_KMS_KEK must never hold real funds', () => {
    resetConfigCacheForTests();
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', KMS_PROVIDER: 'local' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/KMS_PROVIDER=local is not permitted when NODE_ENV=production/);
  });

  it('allows KMS_PROVIDER=local outside production', () => {
    resetConfigCacheForTests();
    const config = loadConfig({ ...base, NODE_ENV: 'development', KMS_PROVIDER: 'local' } as unknown as NodeJS.ProcessEnv);
    expect(config.KMS_PROVIDER).toBe('local');
  });

  it('requires KMS_KEY_ID when KMS_PROVIDER=aws, in any environment', () => {
    resetConfigCacheForTests();
    expect(() =>
      loadConfig({ ...base, KMS_PROVIDER: 'aws', KMS_KEY_ID: '' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/KMS_KEY_ID is required when KMS_PROVIDER=aws/);
  });

  it('allows KMS_PROVIDER=aws in production, given a KMS_KEY_ID and TLS_TERMINATED=true', () => {
    resetConfigCacheForTests();
    const config = loadConfig({
      ...base,
      NODE_ENV: 'production',
      KMS_PROVIDER: 'aws',
      KMS_KEY_ID: 'arn:aws:kms:us-east-1:123456789012:key/abc-def',
      TLS_TERMINATED: 'true',
    } as unknown as NodeJS.ProcessEnv);
    expect(config.KMS_PROVIDER).toBe('aws');
    expect(config.KMS_KEY_ID).toBe('arn:aws:kms:us-east-1:123456789012:key/abc-def');
  });
});

describe('loadConfig: TLS_TERMINATED production guard (wallet import sends a raw private key in the body)', () => {
  const prodBase = {
    ...base,
    NODE_ENV: 'production',
    KMS_PROVIDER: 'aws',
    KMS_KEY_ID: 'arn:aws:kms:us-east-1:123456789012:key/abc-def',
  };

  it('refuses to start when NODE_ENV=production and TLS_TERMINATED is unset', () => {
    resetConfigCacheForTests();
    expect(() => loadConfig({ ...prodBase } as unknown as NodeJS.ProcessEnv)).toThrow(
      /TLS_TERMINATED is not set to true, but NODE_ENV=production/,
    );
  });

  it('refuses to start when TLS_TERMINATED is literally the STRING "false": must not be coerced to true', () => {
    // The exact bug z.coerce.boolean() would introduce: Boolean("false") is true in JS, since any
    // non-empty string is truthy.
    resetConfigCacheForTests();
    expect(() =>
      loadConfig({ ...prodBase, TLS_TERMINATED: 'false' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/TLS_TERMINATED is not set to true, but NODE_ENV=production/);
  });

  it('refuses to start on a garbage TLS_TERMINATED value rather than silently treating it as false or true', () => {
    resetConfigCacheForTests();
    expect(() => loadConfig({ ...prodBase, TLS_TERMINATED: 'yes' } as unknown as NodeJS.ProcessEnv)).toThrow();
  });

  it('starts when TLS_TERMINATED=true is explicitly set in production', () => {
    resetConfigCacheForTests();
    const config = loadConfig({ ...prodBase, TLS_TERMINATED: 'true' } as unknown as NodeJS.ProcessEnv);
    expect(config.TLS_TERMINATED).toBe(true);
  });

  it('TLS_TERMINATED is irrelevant outside production: defaults to false and does not block startup', () => {
    resetConfigCacheForTests();
    const config = loadConfig({ ...base, NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv);
    expect(config.TLS_TERMINATED).toBe(false);
  });
});

describe('loadConfig: signed-mint execution (kill switch and tuning)', () => {
  it('execution is off by default, with the documented tuning defaults', () => {
    resetConfigCacheForTests();
    const config = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(config.SIGNED_MINT_EXECUTION_ENABLED).toBe(false);
    expect(config.SIGNED_MINT_RETRY_INTERVAL_MS).toBe(250);
    expect(config.SIGNED_MINT_GIVE_UP_MS).toBe(60_000);
    expect(config.SIGNED_MINT_OPENSEA_CONCURRENCY).toBe(4);
  });

  it('speed settings: overlap and broadcast racing on, key holding OFF until someone turns it on', () => {
    resetConfigCacheForTests();
    const config = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(config.SIGNED_MINT_OVERLAP_MS).toBe(200);
    expect(config.SIGNED_MINT_MAX_IN_FLIGHT).toBe(3);
    expect(config.RPC_RACE_BROADCAST).toBe(true);
    expect(config.SIGNED_MINT_HOLD_KEYS).toBe(false);

    resetConfigCacheForTests();
    const tuned = loadConfig({ ...base, SIGNED_MINT_HOLD_KEYS: 'true', SIGNED_MINT_OVERLAP_MS: '0', RPC_RACE_BROADCAST: 'false' } as NodeJS.ProcessEnv);
    expect([tuned.SIGNED_MINT_HOLD_KEYS, tuned.SIGNED_MINT_OVERLAP_MS, tuned.RPC_RACE_BROADCAST]).toEqual([true, 0, false]);

    resetConfigCacheForTests();
    expect(() => loadConfig({ ...base, SIGNED_MINT_MAX_IN_FLIGHT: '9' } as NodeJS.ProcessEnv)).toThrow();
  });

  it('turns on only with the literal "true", and rejects an out-of-range retry interval', () => {
    resetConfigCacheForTests();
    expect(loadConfig({ ...base, SIGNED_MINT_EXECUTION_ENABLED: 'true' } as NodeJS.ProcessEnv).SIGNED_MINT_EXECUTION_ENABLED).toBe(true);
    resetConfigCacheForTests();
    expect(() => loadConfig({ ...base, SIGNED_MINT_RETRY_INTERVAL_MS: '5' } as NodeJS.ProcessEnv)).toThrow();
  });

  it('WALLET_DAILY_SPEND_SHARE_PERCENT defaults to 50 when unset or blank, and must be 1 to 100', () => {
    const share = (value?: string) => {
      resetConfigCacheForTests();
      return loadConfig({ ...base, ...(value === undefined ? {} : { WALLET_DAILY_SPEND_SHARE_PERCENT: value }) } as NodeJS.ProcessEnv).WALLET_DAILY_SPEND_SHARE_PERCENT;
    };
    expect(share()).toBe(50);
    expect(share(' ')).toBe(50);
    expect(share('30')).toBe(30);
    expect(() => share('0')).toThrow();
    expect(() => share('150')).toThrow();
    resetConfigCacheForTests();
  });

  it('APP_ORIGIN may list several origins, comma-separated; appOrigins gives them main one first', () => {
    resetConfigCacheForTests();
    const secret = 'x'.repeat(32);
    const config = loadConfig({ ...base, APP_ORIGIN: 'http://localhost:5173, http://localhost:4173', ACCESS_CODE_SECRET: secret } as NodeJS.ProcessEnv);
    expect(appOrigins(config)).toEqual(['http://localhost:5173', 'http://localhost:4173']);
    resetConfigCacheForTests();
    expect(() => loadConfig({ ...base, APP_ORIGIN: 'http://localhost:5173,http://localhost:4173/app', ACCESS_CODE_SECRET: secret } as NodeJS.ProcessEnv)).toThrow(/origin only/);
    resetConfigCacheForTests();
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', KMS_PROVIDER: 'aws', KMS_KEY_ID: 'k', TLS_TERMINATED: 'true', APP_ORIGIN: 'https://app.stryx.xyz,http://localhost:4173', ACCESS_CODE_SECRET: secret } as NodeJS.ProcessEnv)).toThrow(/https/);
    resetConfigCacheForTests();
    expect(appOrigins({ APP_ORIGIN: undefined })).toEqual([]);
  });
  it('terms acceptance is off unless TERMS_VERSION and PRIVACY_VERSION are both set, and they must be sensible', () => {
    resetConfigCacheForTests();
    const off = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(off.TERMS_VERSION).toBeUndefined();
    expect(off.PRIVACY_VERSION).toBeUndefined();
    resetConfigCacheForTests();
    const on = loadConfig({ ...base, TERMS_VERSION: '1.0', PRIVACY_VERSION: '2.1-beta' } as NodeJS.ProcessEnv);
    expect([on.TERMS_VERSION, on.PRIVACY_VERSION]).toEqual(['1.0', '2.1-beta']);
    resetConfigCacheForTests();
    expect(() => loadConfig({ ...base, TERMS_VERSION: '1.0' } as NodeJS.ProcessEnv)).toThrow(/set together/);
    resetConfigCacheForTests();
    expect(() => loadConfig({ ...base, PRIVACY_VERSION: '1.0' } as NodeJS.ProcessEnv)).toThrow(/set together/);
    resetConfigCacheForTests();
    expect(() => loadConfig({ ...base, TERMS_VERSION: 'v 1', PRIVACY_VERSION: '1.0' } as NodeJS.ProcessEnv)).toThrow(/letters, digits/);
    resetConfigCacheForTests();
    expect(() => loadConfig({ ...base, TERMS_VERSION: 'x'.repeat(33), PRIVACY_VERSION: '1.0' } as NodeJS.ProcessEnv)).toThrow(/32 characters/);
    resetConfigCacheForTests();
  });
});

describe('ENABLE_TESTNETS', () => {
  const load = (env: Record<string, string>) => {
    resetConfigCacheForTests();
    return loadConfig({ ...base, ...env } as NodeJS.ProcessEnv);
  };

  it('unset or blank: on outside production', () => {
    expect(testnetsEnabled(load({}))).toBe(true);
    expect(testnetsEnabled(load({ ENABLE_TESTNETS: ' ' }))).toBe(true);
  });

  it('unset: off in production', () => {
    expect(testnetsEnabled({ ENABLE_TESTNETS: undefined, NODE_ENV: 'production' })).toBe(false);
  });

  it('takes "true" / "false" literally, either way round', () => {
    expect(testnetsEnabled(load({ ENABLE_TESTNETS: 'false' }))).toBe(false);
    expect(testnetsEnabled({ ...load({ ENABLE_TESTNETS: 'TRUE' }), NODE_ENV: 'production' })).toBe(true);
  });

  it('refuses anything else rather than guessing', () => {
    expect(() => load({ ENABLE_TESTNETS: 'yes' })).toThrow(/ENABLE_TESTNETS/);
  });
});

describe('HOST', () => {
  it('defaults to every IPv4 interface, and takes :: for an IPv6 private network', () => {
    resetConfigCacheForTests();
    expect(loadConfig({ ...base } as NodeJS.ProcessEnv).HOST).toBe('0.0.0.0');
    resetConfigCacheForTests();
    expect(loadConfig({ ...base, HOST: '::' } as NodeJS.ProcessEnv).HOST).toBe('::');
    resetConfigCacheForTests();
    expect(loadConfig({ ...base, HOST: ' ' } as NodeJS.ProcessEnv).HOST).toBe('0.0.0.0');
  });
});
