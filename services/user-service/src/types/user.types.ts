import { z } from 'zod';

export const UserRoleSchema = z.enum(['USER', 'ADMIN']);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const UserStatusSchema = z.enum(['ACTIVE', 'SUSPENDED']);
export type UserStatus = z.infer<typeof UserStatusSchema>;

/** The full row as persisted: includes the password hash. */
export const UserRecordSchema = z.object({
  id: z.string().min(1),
  /** Null for an account created by wallet sign-in (ADR-003 §4.4): it has no email and no password. */
  email: z.string().email().nullable(),
  passwordHash: z.string().min(1).nullable(),
  role: UserRoleSchema,
  status: UserStatusSchema,
  /** ADR-002 §3.7: null means "use the platform default cap." A decimal wei string, like other wei amounts in this codebase. */
  dailySpendCapWei: z.string().nullable(),
  /** false = unlimited, no cap tracked. */
  spendCapEnabled: z.boolean(),
  /** The name the member chose to be greeted by (see ProfileUpdateSchema). Shown back to them only. */
  displayName: z.string().nullable().default(null),
  /** Optional profile handles, stored normalised (see ProfileUpdateSchema). Never fetched from Discord or X. */
  discordHandle: z.string().nullable().default(null),
  xHandle: z.string().nullable().default(null),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type UserRecord = z.infer<typeof UserRecordSchema>;

/** Fields needed to insert a new user row. */
export type NewUserData = Omit<UserRecord, 'id' | 'createdAt' | 'updatedAt' | 'displayName' | 'discordHandle' | 'xHandle'>;

/** API-safe projection: everything EXCEPT the password hash. */
export type UserSummary = Omit<UserRecord, 'passwordHash'>;

export function toUserSummary(record: UserRecord): UserSummary {
  const { passwordHash: _passwordHash, ...summary } = record;
  return summary;
}
