/** The single gateway to the Stryx API. */

const TOKEN_KEY = 'stryx.token';

/** Fired (on window) when the API says the terms must be accepted first. */
export const TERMS_NEEDED_EVENT = 'stryx:terms-needed';
/** Fired on window when the API says this sign-in is no longer valid. */
export const SESSION_ENDED_EVENT = 'stryx:session-ended';

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

/** What went wrong, in words a page can show as they are: the server's own message when it sent one. */
function describeFailure(status: number, body: unknown): string {
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  if (status === 401) return 'Your session ended. Sign in again.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status >= 502 && status <= 504) return 'Stryx is not reachable right now. Try again in a moment.';
  if (status >= 500) return 'Something went wrong on our side. Try again.';
  return `The request was refused (HTTP ${status}).`;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(describeFailure(status, body));
    this.name = 'ApiError';
  }
}

/** The reply as JSON, or null when it is empty or not JSON at all (a proxy's HTML error page). */
function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (!text) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Core request helper. */
export async function apiRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // Declare a JSON content type only when sending JSON.
  const hasBody = options.body !== undefined;
  if (hasBody) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  const json = parseJson(text);
  // Not JSON: a gateway's own error page, or a wrong address answering with a web page.
  if (!json.ok) throw new ApiError(res.ok ? 502 : res.status, null);
  const parsed = json.value;

  if (!res.ok) {
    // The sign-in itself was refused (not a wrong password in a form, which has its own error code).
    if (res.status === 401 && (parsed as { error?: unknown } | null)?.error === 'unauthorized' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
    }
    // A write refused because the terms are not accepted yet: tell the page, which opens the
    // acceptance dialog.
    if (res.status === 403 && (parsed as { error?: unknown } | null)?.error === 'terms_not_accepted' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event(TERMS_NEEDED_EVENT));
    }
    throw new ApiError(res.status, parsed);
  }
  return parsed as T;
}

/** A file download (the waitlist CSV): the same sign-in as apiRequest, but the body comes back as a file rather than JSON. */
export async function apiDownload(path: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const json = parseJson(await res.text());
    throw new ApiError(res.status, json.ok ? json.value : null);
  }
  return res.blob();
}
