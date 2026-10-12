import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api';
import { describeMintError, describeHalt } from '../src/lib/mint-error';

function apiError(status: number, body: unknown): ApiError {
  return new ApiError(status, body);
}

describe('describeMintError', () => {
  it('reads a plain Error message directly, not through the API-body mapping', () => {
    expect(describeMintError(new Error('network dropped'))).toBe('network dropped');
  });

  it('falls back to a generic message for a non-Error, non-ApiError rejection', () => {
    expect(describeMintError('a plain string rejection')).toBe('Could not reach the API.');
  });

  it('maps every known backend error code to operator-facing text', () => {
    expect(describeMintError(apiError(409, { error: 'no_active_public_stage' }))).toBe('Public stage is not open.');
    expect(describeMintError(apiError(403, { error: 'not_eligible', reason: 'not_on_allowlist' }))).toBe('Not eligible (not_on_allowlist).');
    expect(describeMintError(apiError(403, { error: 'not_eligible' }))).toBe('Not eligible.');
    expect(describeMintError(apiError(402, { error: 'insufficient_funds', message: 'wallet has 0 ETH' }))).toBe('wallet has 0 ETH');
    expect(describeMintError(apiError(402, { error: 'insufficient_funds' }))).toBe('Not enough funds.');
    expect(describeMintError(apiError(500, { error: 'no_fee_recipient_configured' }))).toBe('No fee recipient set on this drop.');
    expect(describeMintError(apiError(423, { error: 'emergency_stop_active', stage: 'public' }))).toBe('Emergency stop active (public). Nothing sent.');
    expect(describeMintError(apiError(423, { error: 'emergency_stop_active' }))).toBe('Emergency stop active. Nothing sent.');
    expect(describeMintError(apiError(422, { error: 'simulation_reverted', message: 'insufficient funds for gas' }))).toBe('Reverted, nothing sent: insufficient funds for gas');
    expect(describeMintError(apiError(422, { error: 'simulation_reverted' }))).toBe('Reverted, nothing sent.');
    expect(describeMintError(apiError(502, { error: 'opensea_fetch_failed', message: 'timed out' }))).toBe('OpenSea proof fetch failed: timed out');
    expect(describeMintError(apiError(404, { error: 'allowlist_not_found' }))).toBe('Allow-list not found.');
    expect(describeMintError(apiError(400, { error: 'unsupported_chain', message: 'chainId=1 has no RPC' }))).toBe('chainId=1 has no RPC');
    expect(describeMintError(apiError(400, { error: 'wallet_key_unavailable', message: 'archived wallet' }))).toBe('archived wallet');
    expect(describeMintError(apiError(400, { error: 'no_wallets' }))).toBe('Select at least one wallet.');
    expect(describeMintError(apiError(400, { error: 'duplicate_wallets' }))).toBe('Duplicate wallet selected.');
    expect(describeMintError(apiError(413, { error: 'too_many_wallets' }))).toBe('Too many wallets for one batch.');
    expect(describeMintError(apiError(429, { error: 'spending_cap_exceeded' }))).toBe('Daily spending cap reached.');
  });

  it('maps every cannot_auto_schedule reason distinctly', () => {
    expect(describeMintError(apiError(409, { error: 'cannot_auto_schedule', reason: 'no_start_time' }))).toBe('No start time on chain. Use a fixed time.');
    expect(describeMintError(apiError(503, { error: 'cannot_auto_schedule', reason: 'chain_unavailable' }))).toBe('Chain unreadable. Try again.');
    expect(describeMintError(apiError(409, { error: 'cannot_auto_schedule', reason: 'stage_ended' }))).toBe('Stage already ended.');
  });

  it('maps the schedule-edit-specific error codes', () => {
    expect(describeMintError(apiError(404, { error: 'schedule_not_found' }))).toBe('Job not found.');
    expect(describeMintError(apiError(409, { error: 'schedule_not_editable' }))).toBe("Can't edit: already firing or finished.");
  });

  it('maps a zod validation_error to its first issue', () => {
    expect(describeMintError(apiError(400, { error: 'validation_error', issues: [{ path: 'mintParams.mintPrice', message: 'Invalid' }] }))).toBe('mintParams.mintPrice: Invalid');
    expect(describeMintError(apiError(400, { error: 'validation_error', issues: [] }))).toBe('Invalid input.');
  });

  it('falls back to a generic HTTP-status message for an unrecognized error code', () => {
    expect(describeMintError(apiError(500, { error: 'something_new' }))).toBe('Mint failed (HTTP 500).');
    expect(describeMintError(apiError(500, { error: 'something_new', message: 'a specific detail' }))).toBe('a specific detail');
  });
});

describe('describeHalt', () => {
  it('maps every known halt reason', () => {
    expect(describeHalt('emergency_stop')).toBe('Halted: emergency stop. Remaining wallets skipped.');
    expect(describeHalt('spending_cap_exceeded')).toBe('Halted: daily spending cap. Remaining wallets skipped.');
    expect(describeHalt('rpc_unavailable')).toBe('Halted: chain unreachable. Remaining wallets skipped.');
  });

  it('falls back to a generic message for an unrecognized reason', () => {
    expect(describeHalt('something_new')).toBe('Halted (something_new).');
  });
});
