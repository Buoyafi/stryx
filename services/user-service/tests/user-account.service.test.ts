import { describe, expect, it } from 'vitest';
import * as argon2 from 'argon2';
import {
  UserAccountService,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
} from '../src/service/user-account.service.js';
import { InMemoryUserRepository } from './fakes/in-memory-user.repository.js';

function makeService() {
  const repository = new InMemoryUserRepository();
  return { service: new UserAccountService(repository), repository };
}

describe('UserAccountService', () => {
  it('signs up a new user with a hashed password, never the plaintext', async () => {
    const { service, repository } = makeService();

    const user = await service.signup({ email: 'Alice@Example.com', password: 'correct-horse-battery-staple' });

    expect(user.email).toBe('alice@example.com'); // normalized lowercase
    expect(user.role).toBe('USER');
    expect(user.status).toBe('ACTIVE');
    expect(user).not.toHaveProperty('passwordHash');

    const stored = await repository.findByEmail('alice@example.com');
    expect(stored!.passwordHash).not.toBe('correct-horse-battery-staple');
    expect(stored!.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('rejects signing up an email that is already registered', async () => {
    const { service } = makeService();
    await service.signup({ email: 'bob@example.com', password: 'password1234' });

    await expect(service.signup({ email: 'bob@example.com', password: 'different-password' })).rejects.toThrow(
      EmailAlreadyRegisteredError,
    );
  });

  it('verifies correct credentials and returns the user', async () => {
    const { service } = makeService();
    await service.signup({ email: 'carol@example.com', password: 'my-real-password' });

    const user = await service.verifyCredentials('carol@example.com', 'my-real-password');
    expect(user.email).toBe('carol@example.com');
  });

  it('is case-insensitive on email for login', async () => {
    const { service } = makeService();
    await service.signup({ email: 'dave@example.com', password: 'my-real-password' });

    const user = await service.verifyCredentials('Dave@Example.com', 'my-real-password');
    expect(user.email).toBe('dave@example.com');
  });

  it('rejects a wrong password with InvalidCredentialsError', async () => {
    const { service } = makeService();
    await service.signup({ email: 'erin@example.com', password: 'my-real-password' });

    await expect(service.verifyCredentials('erin@example.com', 'wrong-password')).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('rejects a nonexistent email with the SAME error as a wrong password (no enumeration)', async () => {
    const { service } = makeService();

    await expect(service.verifyCredentials('nobody@example.com', 'whatever')).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('rejects login for a suspended account', async () => {
    // Built through the repository, bypassing signup(), which always creates ACTIVE.
    const repository = new InMemoryUserRepository();
    const passwordHash = await argon2.hash('my-real-password', { type: argon2.argon2id });
    await repository.create({ email: 'frank@example.com', passwordHash, role: 'USER', status: 'SUSPENDED', dailySpendCapWei: null, spendCapEnabled: true });
    const service = new UserAccountService(repository);

    await expect(service.verifyCredentials('frank@example.com', 'my-real-password')).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('never throws an unhandled error for a malformed/foreign password hash', async () => {
    // Mirrors the reserved operator row's invalid sentinel hash (ADR-002 §3.11): verification throws,
    // and must read as a wrong password.
    const repository = new InMemoryUserRepository();
    await repository.create({ email: 'operator@stryx.local', passwordHash: 'disabled:not-a-real-hash', role: 'ADMIN', status: 'ACTIVE', dailySpendCapWei: null, spendCapEnabled: false });
    const service = new UserAccountService(repository);

    await expect(service.verifyCredentials('operator@stryx.local', 'anything')).rejects.toThrow(
      InvalidCredentialsError,
    );
  });
});
