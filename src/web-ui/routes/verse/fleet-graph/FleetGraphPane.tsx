import { Button } from '../../../components/primitives/Button.js';
import { readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { openDockPane } from '../dock/dock-store.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import { RunsGraph } from '../fleet/RunsGraph.js';
import { runsGraphQuery } from '../fleet/runs-graph-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { SectionVisibilityProvider, useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { liveHeadline, liveIssuesText, liveNodeRows } from './graph-live-model.js';
import { graphLiveMissing, graphLiveQuery, type GraphLiveState } from './graph-live-queries.js';
import { liveNodeSteerPrefill, liveNodeSteerVisible } from './live-node-steer-prefill.js';
import { workerAgeSummary } from './graph-summary.js';
import styles from './fleet-graph.module.css';

const countLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const tone = (state: GraphLiveState) => state === 'ready' ? styles.ok : state === 'limited' ? styles.warn
  : state === 'exhausted' || state === 'held' ? styles.bad : styles.neutral;

export function FleetGraphPane({ visible }: Pick<PaneProps, 'visible'>) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const enabled = visible && sectionVisible && documentVisible;
  const read = useQuery(runsGraphQuery, { enabled, freshMs: 0 });
  const refetch = useRefetch(runsGraphQuery);
  usePollWhileVisible(refetch, 10_000, { enabled: visible && read.data !== null, refreshOnShow: false });
  const liveRead = useQuery(graphLiveQuery, { enabled, freshMs: 0 });
  const refetchLive = useRefetch(graphLiveQuery);
  usePollWhileVisible(() => { if (!graphLiveMissing()) refetchLive(); }, 15_000, { enabled: visible && !graphLiveMissing(), refreshOnShow: false });
  const runs = read.data;
  const summary = runs ? workerAgeSummary(runs.workers) : null;
  const live = liveRead.data;
  const issues = live ? liveIssuesText(live) : null;
  return <div className={styles.pane} aria-label="Fleet graph">
    <header className={styles.summary}>
      {runs ? `${countLabel(runs.lanes?.length ?? 0, 'lane')} · ${countLabel(runs.workers.length, 'worker')} · ${runs.mergesLastHour.count === null ? 'merges unknown' : countLabel(runs.mergesLastHour.count, 'merge')} last hour`
        : runs === null ? 'Fleet runs are not available in this build.' : read.error ? 'Fleet runs could not be read.' : 'Reading fleet runs…'}
      {summary && <span>{` · ${summary}`}</span>}
    </header>
    <SectionVisibilityProvider visible={visible}><RunsGraph /></SectionVisibilityProvider>
    <section className={styles.live} aria-label="Seats and engines">
      <h2>Seats and engines</h2>
      {liveRead.error ? <p>Live node state unavailable: {readFailureReason(liveRead.error)}</p>
        : live === null ? <p>Live node state unavailable: Invalid response.</p>
          : live ? <>
            <p>{liveHeadline(live)}</p>
            {issues?.map((issue, index) => <p key={`${issue}-${index}`}>{issue}</p>)}
            <ul className={styles.rows}>
              {liveNodeRows(live, Date.now()).map(row => {
                const content = <><strong>{row.label}</strong><span className={`${styles.chip} ${tone(row.state)}`}>{row.state}</span>
                  <span>{row.usedText}</span><span>{row.resetText}</span><span>{row.ageText}</span></>;
                const clickable = row.kind === 'seat' || row.kind === 'engine' || row.kind === 'engine-account';
                return <li key={row.id} title={row.reasons.join('; ')}>
                  {clickable ? <button type="button" className={styles.row} onClick={() => openDockPane('fleet-usage')}>{content}</button>
                    : <div className={styles.row}>{content}</div>}
                  {liveNodeSteerVisible(row) && <Button size="sm" aria-label={`Steer ${row.id}`} onClick={event => {
                    event.stopPropagation();
                    openInterjectDialog({ prefill: liveNodeSteerPrefill(row) });
                  }}>Steer</Button>}
                </li>;
              })}
            </ul>
          </> : <p>Reading live node state…</p>}
    </section>
  </div>;
}
