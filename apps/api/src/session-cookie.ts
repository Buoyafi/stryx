/**
 * The session cookie for wallet sign-in (ADR-003 §4.2): HttpOnly, SameSite=Lax, and on https `__Host-`
 * prefixed and Secure, which pins it to this exact host.
 */
export class SessionCookie {
  readonly name: string;
  private readonly secure: boolean;

  constructor(appOrigin: string, private readonly maxAgeSeconds = 60 * 60 * 24 * 30) {
    this.secure = new URL(appOrigin).protocol === 'https:';
    this.name = this.secure ? '__Host-stryx_session' : 'stryx_session';
  }

  /** `maxAgeSeconds` overrides the default for this cookie (an admin's session ends sooner). */
  serialize(token: string, maxAgeSeconds: number = this.maxAgeSeconds): string {
    return `${this.name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${this.secure ? '; Secure' : ''}`;
  }

  clear(): string {
    return `${this.name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.secure ? '; Secure' : ''}`;
  }

  /** The token from a request's Cookie header, if this cookie is there and looks like a token. */
  read(cookieHeader: string | undefined): string | null {
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() !== this.name) continue;
      const value = part.slice(eq + 1).trim();
      return /^[0-9a-f]{64}$/.test(value) ? value : null;
    }
    return null;
  }
}
