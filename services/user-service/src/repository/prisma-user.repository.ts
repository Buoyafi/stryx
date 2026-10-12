import type { UserRepository } from './user.repository.js';
import type { NewUserData, UserRecord, UserStatus } from '../types/user.types.js';
import { UserRecordSchema } from '../types/user.types.js';

/** The minimal subset of a generated Prisma `user` delegate this repository needs. */
export interface UserPrismaDelegate {
  create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  findUnique(args: { where: { email: string } | { id: string } }): Promise<Record<string, unknown> | null>;
  updateMany(args: { where: { id: string }; data: Record<string, unknown> }): Promise<{ count: number }>;
}

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly user: UserPrismaDelegate) {}

  async create(data: NewUserData): Promise<UserRecord> {
    const row = await this.user.create({ data: { ...data, email: data.email?.toLowerCase() ?? null } });
    return UserRecordSchema.parse(row);
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.user.findUnique({ where: { email: email.toLowerCase() } });
    return row ? UserRecordSchema.parse(row) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const row = await this.user.findUnique({ where: { id } });
    return row ? UserRecordSchema.parse(row) : null;
  }

  async updateProfile(id: string, data: { displayName?: string | null; discordHandle?: string | null; xHandle?: string | null }): Promise<UserRecord | null> {
    const patch: Record<string, unknown> = {};
    if (data.displayName !== undefined) patch.displayName = data.displayName;
    if (data.discordHandle !== undefined) patch.discordHandle = data.discordHandle;
    if (data.xHandle !== undefined) patch.xHandle = data.xHandle;
    if (Object.keys(patch).length > 0) {
      const { count } = await this.user.updateMany({ where: { id }, data: patch });
      if (count === 0) return null;
    }
    return this.findById(id);
  }

  async setStatus(id: string, status: UserStatus): Promise<UserRecord | null> {
    const { count } = await this.user.updateMany({ where: { id }, data: { status } });
    return count === 0 ? null : this.findById(id);
  }
}
