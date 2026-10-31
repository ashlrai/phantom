import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { burnLine, burnTotals, formatTokens, headline, laneBars, workerRows } from './fleet-lanes-model.js';
import { LanePauseButton } from './LanePauseButton.js';
import { LaneTargetStepper } from './LaneTargetStepper.js';
import styles from './fleet-lanes.module.css';

function pullUrl(repo: string, number: number): string | null {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) || !Number.isSafeInteger(number) || number <= 0) return null;
  const [owner, name] = repo.split('/');
  if (owner === '.' || owner === '..' || name === '.' || name === '..') return null;
  return `https://github.com/${owner}/${name}/pull/${number}`;
}

export function FleetLanesPane({ visible }: Pick<PaneProps, 'visible'>) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const active = visible && sectionVisible && documentVisible;
  const read = useQuery(opsRunsQuery, { enabled: active, freshMs: 0 });
  const refetch = useRefetch(opsRunsQuery);
  const refresh = useRefresh(opsRunsQuery);
  usePollWhileVisible(refetch, 5_000, { enabled: visible, refreshOnShow: false });
  const data = read.data;
  const workers = data ? workerRows(data) : [];

  return <div className={styles.pane} aria-label="Lanes">
    <header className={styles.header}>
      <p className={styles.headline}>{headline(data ?? null, Date.now())}</p>
      <button type="button" className={styles.refresh} onClick={refresh}>Refresh</button>
    </header>
    {data === null ? <p className={styles.muted}>The fleet runs API has not landed in this build yet.</p>
      : !data ? <p className={styles.muted} role="status">{read.status === 'error' ? 'Fleet runs are unavailable.' : 'Reading fleet runs…'}</p>
      : <>
        {read.status === 'error' ? <p className={styles.muted} role="status">Fleet runs could not refresh. Showing the last reading.</p> : null}
        {data.sources.runsDir !== 'healthy' ? <p className={styles.muted}>Runs directory: {data.sources.runsDir}</p> : null}
        <section className={styles.section} aria-labelledby="fleet-lanes-capacity">
          <h3 id="fleet-lanes-capacity" className={styles.title}>Lane capacity</h3>
          <p className={styles.burn}>{burnLine(burnTotals(data))}</p>
          {data.lanes.length === 0 ? <p className={styles.muted}>No lanes reported.</p> : <ul className={styles.list}>
            {laneBars(data).map((lane) => <li key={lane.lane} className={styles.lane}>
              <div className={styles.line}><strong>{lane.lane}</strong>{lane.held ? <span className={styles.badge} title={lane.heldReason ?? undefined}>Held</span> : null}<span className={styles.count}>{lane.running}/{lane.target} · {lane.queued} queued</span><LaneTargetStepper lane={lane.lane} /><LanePauseButton lane={lane.lane} /><span className={styles.burn}>· {formatTokens(lane.tokensLastHour)} tok/h · {lane.merged24h ?? '—'} merged/24 h</span></div>
              <div className={styles.track} role="img" aria-label={`${lane.lane}: ${lane.running} running of ${lane.target} target`}>
                {lane.fillPct !== null ? <div className={styles.fill} data-tone={lane.tone} style={{ width: `${lane.fillPct}%` }} /> : null}
              </div>
            </li>)}
          </ul>}
        </section>
        <section className={styles.section} aria-labelledby="fleet-lanes-workers">
          <h3 id="fleet-lanes-workers" className={styles.title}>Workers</h3>
          {workers.length === 0 ? <p className={styles.muted}>No workers running.</p> : <ul className={styles.list}>
            {workers.slice(0, 12).map((worker, i) => <li key={`${worker.job}:${i}`} className={styles.worker}><code>{worker.job}</code><span>{worker.lane} · {worker.tier}</span><span>{worker.age}</span></li>)}
          </ul>}
          {workers.length > 12 ? <p className={styles.muted}>+{workers.length - 12} more</p> : null}
        </section>
        <section className={styles.section} aria-labelledby="fleet-lanes-merges">
          <h3 id="fleet-lanes-merges" className={styles.title}>Merged last hour</h3>
          {data.mergesLastHour.items.length === 0 ? <p className={styles.muted}>No merges reported.</p> : <ul className={styles.list}>
            {data.mergesLastHour.items.map((merge, i) => {
              const url = pullUrl(merge.repo, merge.number);
              const label = `${merge.repo} #${merge.number} ${merge.title}`;
              return <li className={styles.merge} key={`${merge.repo}:${merge.number}:${i}`}>{url ? <a href={url} target="_blank" rel="noreferrer">{label}</a> : label}</li>;
            })}
          </ul>}
        </section>
      </>}
  </div>;
}
