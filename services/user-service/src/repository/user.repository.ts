import type { UserStatus, NewUserData, UserRecord } from '../types/user.types.js';

/** Persistence contract for users. */
export interface UserRepository {
  create(data: NewUserData): Promise<UserRecord>;
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  /** Sets only the fields given; null clears one. Returns null when the user does not exist. */
  updateProfile(id: string, data: { displayName?: string | null; discordHandle?: string | null; xHandle?: string | null }): Promise<UserRecord | null>;
  /** Suspend or reactivate an account. Null when there is no such account. */
  setStatus(id: string, status: UserStatus): Promise<UserRecord | null>;
}
