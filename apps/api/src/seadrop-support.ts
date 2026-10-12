import type { PublicClient } from 'viem';
import { SEADROP_ADDRESS } from '@stryx/nft-engine';
import { withTimeout } from '@stryx/utils';

/** Whether SeaDrop is deployed on a chain, at the one address every mint path calls. */
export class SeaDropSupport {
  private known: { deployed: boolean; at: number } | null = null;

  constructor(
    private readonly client: Pick<PublicClient, 'getCode'>,
    private readonly now: () => number = Date.now,
  ) {}

  async isDeployed(): Promise<boolean | null> {
    if (this.known && (this.known.deployed || this.now() - this.known.at < 600_000)) return this.known.deployed;
    try {
      const code = await withTimeout(this.client.getCode({ address: SEADROP_ADDRESS }), 8_000, 'SeaDrop code read');
      const deployed = !!code && code !== '0x';
      this.known = { deployed, at: this.now() };
      return deployed;
    } catch {
      return null;
    }
  }
}

/** The sentence every refusal uses, so the mint page, API and signed runner all say the same thing. */
export function seaDropMissingMessage(chainName: string): string {
  return `Minting isn't supported on ${chainName} yet: SeaDrop (${SEADROP_ADDRESS}) isn't deployed there. Balances and Disperse still work.`;
}
