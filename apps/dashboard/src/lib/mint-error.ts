import { ApiError } from './api';

/** Shown when a request got no usable answer: the server may have acted on it anyway. */
export const OUTCOME_UNKNOWN = 'No answer from the server. Check Activity before retrying.';

/** Answers from our own API that still leave the outcome open: a crash mid-request, and a send it could not confirm. */
const UNSETTLED = new Set(['internal_server_error', 'send_unconfirmed']);

/** The server gave a reason of its own for not sending, so "not sent" is true. */
export function isRefusal(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  const code = (err.body as { error?: unknown } | null)?.error;
  return typeof code === 'string' && !UNSETTLED.has(code);
}

/** Turns an API failure into something an operator can act on. */
export function describeMintError(err: unknown): string {
  if (err instanceof Error && !(err instanceof ApiError)) return err.message;
  if (!(err instanceof ApiError)) return 'Could not reach the API.';
  const body = err.body as { error?: string; message?: string; reason?: string; stage?: string; issues?: { path: string; message: string }[] } | null;
  switch (body?.error) {
    case 'validation_error':
      return body.issues?.[0] ? `${body.issues[0].path}: ${body.issues[0].message}` : 'Invalid input.';
    case 'no_active_public_stage':
      return 'Public stage is not open.';
    case 'not_eligible':
      return `Not eligible${body.reason ? ` (${body.reason})` : ''}.`;
    case 'insufficient_funds':
      return body.message ?? 'Not enough funds.';
    case 'no_fee_recipient_configured':
      return 'No fee recipient set on this drop.';
    case 'emergency_stop_active':
      return `Emergency stop active${body.stage ? ` (${body.stage})` : ''}. Nothing sent.`;
    case 'simulation_reverted':
      return `Reverted, nothing sent${body.message ? `: ${body.message}` : '.'}`;
    case 'opensea_fetch_failed':
      return `OpenSea proof fetch failed${body.message ? `: ${body.message}` : '.'}`;
    case 'allowlist_not_found':
      return 'Allow-list not found.';
    case 'unsupported_chain':
      return body.message ?? 'No RPC for that chain.';
    case 'wallet_key_unavailable':
      return body.message ?? 'Wallet key unusable. Pick another wallet.';
    case 'no_wallets':
      return 'Select at least one wallet.';
    case 'duplicate_wallets':
      return body.message ?? 'Duplicate wallet selected.';
    case 'too_many_wallets':
      return body.message ?? 'Too many wallets for one batch.';
    case 'spending_cap_exceeded':
      return body.message ?? 'Daily spending cap reached.';
    case 'cannot_auto_schedule':
      return body.reason === 'no_start_time'
        ? 'No start time on chain. Use a fixed time.'
        : body.reason === 'chain_unavailable'
          ? 'Chain unreadable. Try again.'
          : body.reason === 'already_scheduled'
            ? 'Already scheduled.'
            : 'Stage already ended.';
    case 'already_scheduled':
      return 'Already scheduled.';
    case 'price_above_limit':
      return 'Price went up. Nothing sent.';
    case 'send_unconfirmed':
      return body.message ?? 'May have been sent. Check Activity before retrying.';
    case 'schedule_not_found':
      return 'Job not found.';
    case 'schedule_not_editable':
      return "Can't edit: already firing or finished.";
    default:
      return body?.message ?? `Mint failed (HTTP ${err.status}).`;
  }
}

export function describeHalt(reason: string): string {
  switch (reason) {
    case 'emergency_stop':
      return 'Halted: emergency stop. Remaining wallets skipped.';
    case 'spending_cap_exceeded':
      return 'Halted: daily spending cap. Remaining wallets skipped.';
    case 'rpc_unavailable':
      return 'Halted: chain unreachable. Remaining wallets skipped.';
    default:
      return `Halted (${reason}).`;
  }
}
