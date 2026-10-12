import { OpenSeaDropClient, type OpenSeaAllowListData } from '../../src/opensea-drop-client.js';

/** Test double for OpenSeaDropClient. */
export class FakeOpenSeaDropClient extends OpenSeaDropClient {
  constructor(
    private readonly behavior:
      | { kind: 'success'; data: OpenSeaAllowListData }
      | { kind: 'throw'; error: Error }
      | { kind: 'unused' } = { kind: 'unused' },
  ) {
    // fetch that throws if ever called: proves tests never hit the network.
    super(
      (() => {
        throw new Error('FakeOpenSeaDropClient: real fetch must not be called');
      }) as never,
      'fake-key',
    );
  }

  // Same parameters as the real method (unused here), so a test subclass can override it with them and
  // still type-check against this class.
  override async fetchAllowListData(_slug?: string, _minter?: `0x${string}`, _quantity?: number): Promise<OpenSeaAllowListData> {
    if (this.behavior.kind === 'throw') throw this.behavior.error;
    if (this.behavior.kind === 'success') return this.behavior.data;
    throw new Error('FakeOpenSeaDropClient was called but no behavior was configured');
  }
}
