import { useState } from 'react';
import { ChainIcon } from '@stryx/chain-ui/react';
import { viewForChainId } from '@stryx/chain-ui';
import { chainById } from '@stryx/chains';
import { SegmentedControl } from '../SegmentedControl';
import { OutcomesChart } from './OutcomesChart';
import { Notice } from '../Notice';
import { reasonOf } from '../../lib/account';
import { useCollectionName } from '../../lib/useCollectionName';
import { CLASS_HINT, CLASS_LABEL, SOURCE_LABEL, WINDOWS, count, gas, rate, reasonLabel, shortAddress, useOverview, type FailureClass, type Overview, type StatsWindow } from '../../lib/admin-overview';

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="ov-tile">
      <span className="ov-tile__label">{label}</span>
      <b className="ov-tile__value">{value}</b>
      {sub && <span className="ov-tile__sub">{sub}</span>}
    </div>
  );
}

function ChainName({ chainId }: { chainId: number }) {
  const name = chainById(chainId)?.name ?? `Chain ${chainId}`;
  return (
    <span className="ov-chain">
      <span className="ov-chain__icon">
        <ChainIcon chain={viewForChainId(chainId, name)} interactive={false} />
      </span>
      {name}
    </span>
  );
}

function CollectionCell({ chainId, contract }: { chainId: number; contract: string }) {
  const { name } = useCollectionName(chainId, contract);
  return (
    <span className="ov-collection" title={contract}>
      <b>{name ?? shortAddress(contract)}</b>
      <small>
        <ChainName chainId={chainId} />
      </small>
    </span>
  );
}

const CLASSES: readonly FailureClass[] = ['USER', 'POLICY', 'INFRA', 'CHAIN', 'OTHER'];

function Numbers({ data }: { data: Overview }) {
  const m = data.mints;
  const failed = m.settled - m.confirmed;
  const windowLabel = WINDOWS.find((w) => w.value === data.window)?.label ?? data.window;
  return (
    <>
      <div className="ov-tiles" aria-label="Headline numbers">
        <Tile label="Members" value={count(data.members.total)} sub={`${count(data.members.new)} new in ${windowLabel}`} />
        <Tile label="Active members" value={count(data.members.active)} sub={`${count(data.members.activated)} have a wallet or minted`} />
        <Tile label="Mints" value={count(m.settled)} sub={m.pending > 0 ? `${count(m.pending)} still pending` : `${count(m.confirmed)} confirmed`} />
        <Tile label="Success rate" value={m.successRate === null ? 'No mints' : rate(m.successRate)} sub={m.settled > 0 ? `${count(failed)} failed` : 'in this period'} />
        <Tile label="Platform health" value={m.healthRate === null ? '-' : rate(m.healthRate)} sub="Leaves out member and policy failures" />
      </div>

      {data.series && (
        <section className="admin-card" aria-labelledby="ov-series">
          <div className="admin-card__head">
            <h2 id="ov-series">Mints over time</h2>
            <small>{data.series.unit === 'hour' ? 'By hour, your time' : 'By day, UTC'}</small>
          </div>
          <OutcomesChart buckets={data.series.buckets} unit={data.series.unit} />
        </section>
      )}

      <div className="ov-grid">
        <section className="admin-card" aria-labelledby="ov-failures">
          <div className="admin-card__head">
            <h2 id="ov-failures">Why mints failed</h2>
            <small>{count(failed)} failed</small>
          </div>
          {failed === 0 ? (
            <p className="ov-empty">{m.settled === 0 ? 'No mints in this period.' : 'Nothing failed in this period.'}</p>
          ) : (
            <>
              <ul className="ov-list" aria-label="Failures by kind">
                {CLASSES.filter((c) => m.failures[c] > 0).map((c) => (
                  <li key={c}>
                    <span>
                      <b>{CLASS_LABEL[c]}</b>
                      <small>{CLASS_HINT[c]}</small>
                    </span>
                    <span className="ov-num">{count(m.failures[c])}</span>
                  </li>
                ))}
              </ul>
              <h3 className="ov-subhead">Most common reasons</h3>
              <ul className="ov-list ov-list--tight" aria-label="Most common reasons">
                {m.topReasons.map((r) => (
                  <li key={r.reason}>
                    <span>
                      {reasonLabel(r.reason)}
                      <small>{CLASS_LABEL[r.failureClass]}</small>
                    </span>
                    <span className="ov-num">{count(r.count)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="admin-card" aria-labelledby="ov-sources">
          <div className="admin-card__head">
            <h2 id="ov-sources">How mints were started</h2>
          </div>
          {data.sources.length === 0 ? (
            <p className="ov-empty">No mints in this period.</p>
          ) : (
            <ul className="ov-list" aria-label="Mints by how they were started">
              {data.sources.map((s) => (
                <li key={s.source}>
                  <span>{SOURCE_LABEL[s.source] ?? s.source}</span>
                  <span className="ov-num">{count(s.count)}</span>
                </li>
              ))}
            </ul>
          )}
          <h3 className="ov-subhead">Accounts</h3>
          <ul className="ov-list ov-list--tight">
            <li>
              <span>Admins</span>
              <span className="ov-num">{count(data.members.admins)}</span>
            </li>
            <li>
              <span>Suspended members</span>
              <span className="ov-num">{count(data.members.suspended)}</span>
            </li>
          </ul>
        </section>
      </div>

      <section className="admin-card" aria-labelledby="ov-chains">
        <div className="admin-card__head">
          <h2 id="ov-chains">By chain</h2>
          <small>Gas in each chain’s own token</small>
        </div>
        {data.chains.length === 0 ? (
          <p className="ov-empty">No mints in this period.</p>
        ) : (
          <div className="ov-table-wrap">
            <table className="ov-table">
              <thead>
                <tr>
                  <th scope="col">Chain</th>
                  <th scope="col">Mints</th>
                  <th scope="col">Success</th>
                  <th scope="col">Pending</th>
                  <th scope="col">Gas paid</th>
                  <th scope="col">Lost to reverts</th>
                </tr>
              </thead>
              <tbody>
                {data.chains.map((c) => (
                  <tr key={c.chainId}>
                    <th scope="row">
                      <ChainName chainId={c.chainId} />
                    </th>
                    <td data-label="Mints">{count(c.settled)}</td>
                    <td data-label="Success">{rate(c.successRate)}</td>
                    <td data-label="Pending">{count(c.pending)}</td>
                    <td data-label="Gas paid" className="mono">{gas(c.chainId, c.feeWei)}</td>
                    <td data-label="Lost to reverts" className="mono">{gas(c.chainId, c.burnedWei)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="admin-card" aria-labelledby="ov-collections">
        <div className="admin-card__head">
          <h2 id="ov-collections">Top collections</h2>
          <small>By mints</small>
        </div>
        {data.collections.length === 0 ? (
          <p className="ov-empty">No mints in this period.</p>
        ) : (
          <div className="ov-table-wrap">
            <table className="ov-table">
              <thead>
                <tr>
                  <th scope="col">Collection</th>
                  <th scope="col">Mints</th>
                  <th scope="col">Confirmed</th>
                  <th scope="col">Members</th>
                </tr>
              </thead>
              <tbody>
                {data.collections.map((c) => (
                  <tr key={`${c.chainId}:${c.contract}`}>
                    <th scope="row">
                      <CollectionCell chainId={c.chainId} contract={c.contract} />
                    </th>
                    <td data-label="Mints">{count(c.mints)}</td>
                    <td data-label="Confirmed">{count(c.confirmed)}</td>
                    <td data-label="Members">{count(c.members)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/**
 * The platform at a glance, for a window (24 hours, 7 days, 30 days): members, mints, success and
 * platform health, why mints failed, by chain and by collection.
 */
export function OverviewPanel() {
  const [window, setWindow] = useState<StatsWindow>('7d');
  const overview = useOverview(window);
  const data = overview.data;
  return (
    <div className="ov">
      <div className="ov-bar">
        <SegmentedControl label="Period" options={WINDOWS} value={window} onChange={setWindow} />
        {data && (
          <small className="ov-asof">
            Updated {new Date(data.asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {data.dataStartsAt ? ` · history since ${new Date(data.dataStartsAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}` : ' · no mints recorded yet'}
          </small>
        )}
      </div>
      {overview.isError && !data && <Notice tone="error">{reasonOf(overview.error, 'Could not load the numbers.')}</Notice>}
      {overview.isLoading ? (
        <div className="ov-tiles" aria-busy="true" aria-label="Loading the numbers">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="ov-tile">
              <div className="skeleton" style={{ height: 52 }} />
            </div>
          ))}
        </div>
      ) : data ? (
        <Numbers data={data} />
      ) : null}
    </div>
  );
}
