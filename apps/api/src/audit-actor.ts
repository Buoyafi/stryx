import type { FastifyRequest } from 'fastify';

/**
 * Who an audit entry says acted, as far as the credential tells: the operator token acting with admin
 * rights is 'admin'; a signed-in account, or the token where it may not act as admin, is 'user'.
 */
export const credentialActorType = (request: FastifyRequest): 'user' | 'admin' => (request.sessionToken || request.adminDenied ? 'user' : 'admin');
