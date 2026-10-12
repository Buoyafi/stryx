import { CHAINS } from '@stryx/chains';
import { ChainIcon } from '@stryx/chain-ui/react';
import { viewForChainId } from '@stryx/chain-ui';

/** Mainnets only: the testnet is for rehearsals, not something to show off. */
const SHOWN = CHAINS.filter((c) => !c.isTestnet);

/** The supported chains, sliding slowly across. */
export function ChainMarquee() {
  return (
    <section className="marquee" aria-label={`Supported chains: ${SHOWN.length}`}>
      <div className="marquee__cap">
        <b>Works on {SHOWN.length} chains</b>
      </div>
      <div className="marquee__view">
        <div className="marquee__lane">
          <ul className="marquee__track">
            {SHOWN.map((c) => (
              <li key={c.chainId}>
                <ChainIcon chain={viewForChainId(c.chainId, c.name)} />
              </li>
            ))}
          </ul>
          <ul className="marquee__track" aria-hidden="true">
            {SHOWN.map((c) => (
              <li key={c.chainId}>
                <ChainIcon chain={viewForChainId(c.chainId, c.name)} interactive={false} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
