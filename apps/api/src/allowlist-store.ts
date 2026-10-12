import type { AllowListEntry } from '@stryx/eligibility';

/** Storage for allow-lists the server holds, for mints where the server derives the proof. */
export interface AllowListStore {
  get(allowListId: string): Promise<readonly AllowListEntry[] | null>;
  set(allowListId: string, entries: readonly AllowListEntry[]): Promise<void>;
}

/** In-memory implementation: lists are lost on restart. */
export class InMemoryAllowListStore implements AllowListStore {
  private readonly lists = new Map<string, readonly AllowListEntry[]>();

  async get(allowListId: string): Promise<readonly AllowListEntry[] | null> {
    return this.lists.get(allowListId) ?? null;
  }

  async set(allowListId: string, entries: readonly AllowListEntry[]): Promise<void> {
    this.lists.set(allowListId, entries);
  }
}
