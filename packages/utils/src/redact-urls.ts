/**
 * Removes URLs from text that is about to leave the server or be stored: error text often echoes an
 * endpoint with an API key in it.
 */
export const REDACTED_URL = '[url]';

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)\]}]+/gi;

export function redactUrls(text: string): string {
  return text.replace(URL_PATTERN, REDACTED_URL);
}

/**
 * Like redactUrls, but keeps the site's domain ("[url: alchemy.com]") so a server log still says which
 * provider failed. Only the last two labels of the host are kept, since a key can sit in a subdomain.
 */
export function redactUrlsKeepDomain(text: string): string {
  return text.replace(URL_PATTERN, (url) => {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return REDACTED_URL;
    }
    if (!host) return REDACTED_URL;
    const isAddress = host.startsWith('[') || /^[\d.]+$/.test(host);
    return `[url: ${isAddress ? host : host.split('.').filter(Boolean).slice(-2).join('.')}]`;
  });
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Returns a copy of `value` with every string inside it passed through redactUrls. */
export function redactUrlsDeep<T>(value: T): T {
  if (typeof value === 'string') return redactUrls(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactUrlsDeep(v)) as T;
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactUrlsDeep(v)])) as T;
  return value;
}

/** Like redactUrlsDeep, but only for keys that hold error text: a successful response can carry real URLs beside an error. */
export function redactUrlsInKeys<T>(value: T, keys: ReadonlySet<string>): T {
  if (Array.isArray(value)) return value.map((v) => redactUrlsInKeys(v, keys)) as T;
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, keys.has(k) && typeof v === 'string' ? redactUrls(v) : redactUrlsInKeys(v, keys)]),
    ) as T;
  }
  return value;
}
