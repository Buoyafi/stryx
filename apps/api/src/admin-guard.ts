import type { FastifyRequest } from 'fastify';

interface RoleRecord {
  role: string;
  status: string;
}

/**
 * The one admin check every admin route uses (ADR-003 §4.10). Role and status are read from the
 * database on every request, so a demotion or suspension takes effect at once.
 */
export async function adminCaller<T extends RoleRecord>(request: FastifyRequest, findUser: (id: string) => Promise<T | null>): Promise<T | null> {
  if (request.adminDenied || !request.userId) return null;
  const user = await findUser(request.userId);
  return user && user.role === 'ADMIN' && user.status === 'ACTIVE' ? user : null;
}
