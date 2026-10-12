import type { UserId } from '@stryx/wallet-service';

/**
 * Attached by auth.ts once a request is authenticated: the reserved operator for the operator token,
 * or the session's own user.
 */
declare module 'fastify' {
  interface FastifyRequest {
    userId?: UserId;
    /** Only set for a session-authenticated request: lets /auth/logout revoke the exact session that made the call. */
    sessionToken?: string;
    /**
     * Set when the operator API token authenticated this request in 'api' mode: it acts as the
     * operator, but every admin check refuses it.
     */
    adminDenied?: boolean;
  }
}
