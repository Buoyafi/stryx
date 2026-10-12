import type { FastifyReply } from 'fastify';
import type { MintOutcome } from './mint-execution.service.js';

/** Maps a MintExecutionService MintOutcome to an HTTP response. */
export function sendMintOutcome(reply: FastifyReply, outcome: MintOutcome): FastifyReply {
  if (outcome.ok) {
    return reply.code(202).send(outcome.result);
  }

  switch (outcome.reason) {
    case 'unsupported_chain':
      return reply.code(400).send({ error: 'unsupported_chain', message: `chainId=${outcome.detail} has no RPC configured on this instance.` });
    case 'no_active_public_stage':
      return reply.code(409).send({ error: 'no_active_public_stage', message: 'This contract has no live public mint stage right now.' });
    case 'no_fee_recipient_configured':
      return reply.code(409).send({ error: 'no_fee_recipient_configured', message: 'SeaDrop has no allowed fee recipient configured for this contract.' });
    case 'not_eligible':
      return reply.code(403).send({ error: 'not_eligible', reason: outcome.detail });
    case 'insufficient_funds':
      // 402: the wallet may mint but cannot pay. Distinct from 403, and fixed by funding it.
      return reply.code(402).send({ error: 'insufficient_funds', message: outcome.detail ?? 'Wallet does not hold enough funds to mint.' });
    case 'allowlist_not_found':
      return reply.code(404).send({ error: 'allowlist_not_found', allowListId: outcome.detail });
    case 'opensea_fetch_failed':
      return reply.code(502).send({ error: 'opensea_fetch_failed', message: outcome.detail });
    case 'emergency_stop':
      return reply.code(423).send({ error: 'emergency_stop_active', stage: outcome.stage });
    case 'simulation_reverted':
      return reply.code(422).send({ error: 'simulation_reverted', message: outcome.detail });
    case 'rpc_unavailable':
      // 502: the chain could not be reached, as opposed to 422 for a revert.
      return reply.code(502).send({ error: 'rpc_unavailable', message: outcome.detail, stage: outcome.stage });
    case 'wallet_not_active':
      return reply.code(409).send({ error: 'wallet_not_active', message: outcome.detail });
    case 'price_above_limit':
      return reply.code(409).send({ error: 'price_above_limit', message: outcome.detail });
    case 'send_unconfirmed':
      return reply.code(502).send({ error: 'send_unconfirmed', message: outcome.detail, hash: outcome.hash });
    case 'history_unavailable':
      return reply.code(503).send({ error: 'history_unavailable', message: outcome.detail });
    case 'spending_cap_exceeded':
      // 429: a daily limit, not a permanent rejection.
      return reply.code(429).send({ error: 'spending_cap_exceeded', message: outcome.detail });
    default: {
      // Exhaustiveness guard: a new MintFailureReason without a case here fails to compile.
      const _exhaustive: never = outcome.reason;
      return reply.code(500).send({ error: 'unknown_mint_failure', reason: String(_exhaustive) });
    }
  }
}
