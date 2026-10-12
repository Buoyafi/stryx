/** The waitlist invite email, and the mail service that sends it. */

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** The mail service drops a second send with the same key, so a retried request never sends twice. */
  idempotencyKey: string;
}

export interface Mailer {
  send(email: OutgoingEmail): Promise<void>;
}

export interface InviteEmailInput {
  code: string;
  expiresAt: Date;
  /** The dashboard, e.g. https://app.gostryx.com. The images are served from its /brand/. */
  appUrl: string;
  /** The landing page, e.g. https://gostryx.com. */
  siteUrl: string;
  xUrl: string;
}

/** Stryx on X, linked from the email footer. */
export const STRYX_X_URL = 'https://x.com/stryxapp';

/** The landing page: SITE_URL, else the dashboard origin without a leading "app.". */
export function landingUrl(siteUrl: string | undefined, appUrl: string): string {
  if (siteUrl) return new URL(siteUrl).origin;
  const url = new URL(appUrl);
  url.hostname = url.hostname.replace(/^app\./, '');
  return url.origin;
}

export const INVITE_SUBJECT = "You're in: your Stryx invite";

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const host = (url: string) => new URL(url).host;

/** "23 October 2026", in UTC so it is the same day the server counts. */
export function inviteExpiryDay(at: Date): string {
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The dashboard's Home with the code filled in (the welcome card reads ?code= and then clears it from the address bar). */
export function claimUrl(appUrl: string, code: string): string {
  const url = new URL('/home', appUrl);
  url.searchParams.set('code', code);
  return url.toString();
}

export function inviteEmail(input: InviteEmailInput): { subject: string; html: string; text: string } {
  const app = input.appUrl.replace(/\/+$/, '');
  const site = input.siteUrl.replace(/\/+$/, '');
  const claim = claimUrl(app, input.code);
  const day = inviteExpiryDay(input.expiresAt);
  const appHost = host(app);
  const year = input.expiresAt.getUTCFullYear();

  const text = [
    'Your spot in the Stryx private beta is ready',
    '',
    "Thanks for joining the waitlist. We're letting people in a few at a time, and it's your turn.",
    '',
    'Stryx is one console for your mints: public stages, allowlists and scheduled drops across every wallet and chain you run.',
    '',
    `Your invite code: ${input.code}`,
    `Single use, valid until ${day}.`,
    '',
    `Claim your access: ${claim}`,
    '',
    'How to get in',
    `1. Open ${appHost}, or use the link above.`,
    '2. Enter your invite code.',
    "3. Connect your wallet and sign the message. It's free: a signature, not a transaction.",
    '',
    `Stay safe: Stryx will never ask for your seed phrase or private key, by email or anywhere else. Only enter your code at ${appHost}.`,
    '',
    'See you inside,',
    'The Stryx team',
    '',
    '--',
    `Stryx: manage all your mints from one console. ${site}`,
    `Follow us on X: ${input.xUrl}`,
    `You're receiving this because you joined the Stryx waitlist at ${host(site)}.`,
    "Didn't sign up? You can ignore this email; the code expires on its own.",
  ].join('\n');

  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  const mono = "'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace";
  const step = (n: number, body: string) => `
              <tr>
                <td width="34" valign="top" style="padding:0 0 12px 0;">
                  <div style="width:24px;height:24px;border-radius:12px;background:#14131F;color:#CCFF00;font:700 13px/24px ${font};text-align:center;">${n}</div>
                </td>
                <td valign="top" style="padding:1px 0 12px 0;font:15px/1.5 ${font};color:#14131F;">${body}</td>
              </tr>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(INVITE_SUBJECT)}</title>
</head>
<body style="margin:0;padding:0;background:#ECEBF5;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your private access code for the Stryx console is inside.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ECEBF5;">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#FFFFFF;border-radius:14px;overflow:hidden;">
        <tr>
          <td style="background:#0E0F0A;padding:28px 36px;">
            <a href="${esc(site)}" style="text-decoration:none;"><img src="${esc(app)}/brand/email-lockup.png" width="150" height="34" alt="Stryx" style="display:block;border:0;width:150px;height:34px;"></a>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 36px 30px 36px;">
            <h1 style="margin:0 0 14px 0;font:700 26px/1.25 ${font};color:#14131F;">Your spot in the Stryx private beta is ready</h1>
            <p style="margin:0 0 16px 0;font:16px/1.6 ${font};color:#14131F;">Thanks for joining the waitlist. We're letting people in a few at a time, and it's your turn.</p>
            <p style="margin:0 0 26px 0;font:16px/1.6 ${font};color:#14131F;">Stryx is one console for your mints: public stages, allowlists and scheduled drops across every wallet and chain you run.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="border:1.5px dashed #C9C6E8;background:#F6F5FF;border-radius:12px;padding:18px;">
                  <div style="font:600 12px ${font};letter-spacing:2px;color:#6B6880;">YOUR INVITE CODE</div>
                  <div style="margin-top:6px;font:700 22px ${mono};letter-spacing:1px;white-space:nowrap;color:#14131F;">${esc(input.code)}</div>
                </td>
              </tr>
            </table>
            <p style="margin:8px 0 26px 0;font:13px ${font};color:#6B6880;text-align:center;">Single use · valid until ${esc(day)}</p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 30px auto;">
              <tr>
                <td align="center" style="background:#CCFF00;border-radius:999px;">
                  <a href="${esc(claim)}" style="display:inline-block;padding:15px 34px;font:700 16px ${font};color:#0E0F0A;text-decoration:none;border-radius:999px;">Claim your access</a>
                </td>
              </tr>
            </table>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #ECEBF5;">
              <tr><td colspan="2" style="padding:22px 0 12px 0;font:700 13px ${font};letter-spacing:1.5px;color:#6B6880;">HOW TO GET IN</td></tr>${step(1, `Open <a href="${esc(claim)}" style="color:#14131F;font-weight:700;text-decoration:none;">${esc(appHost)}</a>, or tap the button above.`)}${step(2, 'Enter your invite code.')}${step(3, "Connect your wallet and sign the message. It's free: a signature, not a transaction.")}
            </table>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 22px 0;">
              <tr>
                <td style="background:#F6F5FF;border-left:3px solid #7F77DD;border-radius:6px;padding:12px 16px;font:14px/1.5 ${font};color:#3A3850;"><b>Stay safe:</b> Stryx will never ask for your seed phrase or private key, by email or anywhere else. Only enter your code at ${esc(appHost)}.</td>
              </tr>
            </table>
            <p style="margin:0;font:16px/1.6 ${font};color:#14131F;">See you inside,<br><b>The Stryx team</b></p>
          </td>
        </tr>
        <tr>
          <td align="center" style="background:#0E0F0A;padding:28px 36px;font:12.5px/1.6 ${font};color:#A9AD98;">
            <img src="${esc(app)}/brand/email-mark.png" width="36" height="36" alt="" style="display:block;border:0;margin:0 auto 10px auto;width:36px;height:36px;">
            <div><b style="color:#F4F6EC;">Stryx</b>: manage all your mints from one console</div>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:12px auto;">
              <tr>
                <td style="padding:0 8px;vertical-align:middle;"><a href="${esc(site)}" style="color:#F4F6EC;text-decoration:none;font:13px ${font};">${esc(host(site))}</a></td>
                <td style="padding:0 8px;vertical-align:middle;"><a href="${esc(input.xUrl)}" style="text-decoration:none;"><img src="${esc(app)}/brand/email-x.png" width="28" height="28" alt="Stryx on X" style="display:block;border:0;width:28px;height:28px;"></a></td>
              </tr>
            </table>
            <div>You're receiving this because you joined the Stryx waitlist at ${esc(host(site))}.<br>Didn't sign up? You can ignore this email; the code expires on its own.</div>
            <div style="margin-top:10px;">© ${year} Stryx</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  return { subject: INVITE_SUBJECT, html, text };
}

/** Sends through Resend's HTTP API (resend.com): one POST, no SDK. */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly replyTo: string | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(email: OutgoingEmail): Promise<void> {
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', 'idempotency-key': email.idempotencyKey },
      body: JSON.stringify({ from: this.from, to: [email.to], subject: email.subject, html: email.html, text: email.text, ...(this.replyTo ? { reply_to: this.replyTo } : {}) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      // Resend explains itself in { message }; that goes to the admin, never the key.
      let reason = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { message?: unknown };
        if (typeof body.message === 'string' && body.message) reason = body.message.slice(0, 200);
      } catch {
        // not JSON: the status will do
      }
      throw new Error(`The mail service refused the email (${reason}).`);
    }
  }
}
