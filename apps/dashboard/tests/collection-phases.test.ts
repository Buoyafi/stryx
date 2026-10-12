// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  apiRequest: apiRequestMock,
}));

import { fetchCollectionPhases } from '../src/lib/collection-phases';

beforeEach(() => {
  apiRequestMock.mockReset();
});

describe('fetchCollectionPhases', () => {
  it('reads the per-collection phases route', async () => {
    apiRequestMock.mockResolvedValueOnce({ chainId: 46630, contract: '0xabc', phases: [] });
    const result = await fetchCollectionPhases(46630, '0xabc');
    expect(apiRequestMock).toHaveBeenCalledWith('/chains/46630/collections/0xabc/phases');
    expect(result.phases).toEqual([]);
  });
});
