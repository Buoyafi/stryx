import { describe, expect, it, vi } from 'vitest';
import { StepUpStore } from '../src/step-up-store.js';
import { InMemoryRedisClient } from './fakes/in-memory-redis-client.js';

describe('StepUpStore', () => {
  it('is not granted for a userId that never granted', async () => {
    const store = new StepUpStore(new InMemoryRedisClient());
    expect(await store.isGranted('user-1')).toBe(false);
  });

  it('is granted right after granting', async () => {
    const store = new StepUpStore(new InMemoryRedisClient());
    await store.grant('user-1');
    expect(await store.isGranted('user-1')).toBe(true);
  });

  it('does not leak a grant across userIds', async () => {
    const store = new StepUpStore(new InMemoryRedisClient());
    await store.grant('user-1');
    expect(await store.isGranted('user-2')).toBe(false);
  });

  it('revoke clears an existing grant immediately', async () => {
    const store = new StepUpStore(new InMemoryRedisClient());
    await store.grant('user-1');
    await store.revoke('user-1');
    expect(await store.isGranted('user-1')).toBe(false);
  });

  it('expires on its own after the TTL, with no explicit revoke', async () => {
    vi.useFakeTimers();
    try {
      const store = new StepUpStore(new InMemoryRedisClient(), 'stepup', 300);
      await store.grant('user-1');
      expect(await store.isGranted('user-1')).toBe(true);

      vi.advanceTimersByTime(301_000);
      expect(await store.isGranted('user-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
