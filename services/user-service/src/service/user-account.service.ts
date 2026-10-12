import * as argon2 from 'argon2';
import type { UserRepository } from '../repository/user.repository.js';
import { toUserSummary, type UserSummary } from '../types/user.types.js';
import type { ProfileUpdate, SignupInput } from '../dto/auth.dto.js';

export class EmailAlreadyRegisteredError extends Error {
  constructor(email: string) {
    super(`An account with email ${email} already exists`);
    this.name = 'EmailAlreadyRegisteredError';
  }
}

/**
 * The same error for "no such email", "wrong password" and "account suspended", so a response never
 * tells which emails are registered.
 */
export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid email or password');
    this.name = 'InvalidCredentialsError';
  }
}

/** Account lifecycle: signup and credential verification. */
export class UserAccountService {
  constructor(private readonly repository: UserRepository) {}

  async signup(input: SignupInput): Promise<UserSummary> {
    const existing = await this.repository.findByEmail(input.email);
    if (existing) throw new EmailAlreadyRegisteredError(input.email);

    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const record = await this.repository.create({
      email: input.email,
      passwordHash,
      role: 'USER',
      status: 'ACTIVE',
      // ADR-002 §3.7: a new account starts at the platform default cap.
      dailySpendCapWei: null,
      spendCapEnabled: true,
    });
    return toUserSummary(record);
  }

  async verifyCredentials(email: string, password: string): Promise<UserSummary> {
    const record = await this.repository.findByEmail(email);
    if (!record) {
      // Hash anyway, so a missing email does not answer faster than a wrong password.
      await argon2.hash(password, { type: argon2.argon2id });
      throw new InvalidCredentialsError();
    }

    // A suspended account fails the same way as a wrong password.
    if (record.status !== 'ACTIVE') {
      await argon2.hash(password, { type: argon2.argon2id });
      throw new InvalidCredentialsError();
    }

    // A wallet-only account (ADR-003) has no password at all: it can never sign in this way.
    if (!record.passwordHash) {
      await argon2.hash(password, { type: argon2.argon2id });
      throw new InvalidCredentialsError();
    }

    let valid: boolean;
    try {
      valid = await argon2.verify(record.passwordHash, password);
    } catch {
      // A malformed hash (such as the reserved operator row's sentinel) can never verify: treated as a
      // wrong password.
      valid = false;
    }
    if (!valid) throw new InvalidCredentialsError();

    return toUserSummary(record);
  }

  /** Saves the display name and profile handles that were sent (already validated by ProfileUpdateSchema). */
  async updateProfile(id: string, update: ProfileUpdate): Promise<UserSummary | null> {
    const patch: { displayName?: string | null; discordHandle?: string | null; xHandle?: string | null } = {};
    if (update.displayName !== undefined) patch.displayName = update.displayName;
    if (update.discordHandle !== undefined) patch.discordHandle = update.discordHandle;
    if (update.xHandle !== undefined) patch.xHandle = update.xHandle;
    const record = await this.repository.updateProfile(id, patch);
    return record ? toUserSummary(record) : null;
  }

  /** Suspend or reactivate an account (an admin action; the caller checks who may). */
  async setStatus(id: string, status: UserSummary['status']): Promise<UserSummary | null> {
    const record = await this.repository.setStatus(id, status);
    return record ? toUserSummary(record) : null;
  }

  async getUserSummary(id: string): Promise<UserSummary | null> {
    const record = await this.repository.findById(id);
    return record ? toUserSummary(record) : null;
  }
}
