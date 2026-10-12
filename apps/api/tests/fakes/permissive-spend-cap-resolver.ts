import { UserAccountService } from '@stryx/user-service';
import { CHAINS } from '@stryx/chains';
import { SpendCapResolver } from '../../src/spend-cap-resolver.js';
import { InMemoryUserRepository } from './in-memory-user.repository.js';

/** A SpendCapResolver that is effectively unlimited, for tests that are not about spending caps. */
export function makePermissiveSpendCapResolver(): SpendCapResolver {
  const huge = 2n ** 128n;
  return new SpendCapResolver(new UserAccountService(new InMemoryUserRepository()), huge, new Map(CHAINS.map((c) => [c.chainId, huge])));
}
