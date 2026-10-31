import { Gauge } from '../../../components/charts/Gauge.js';
import { StatTile } from '../../../components/charts/StatTile.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { hostView } from './fleet-host-model.js';
import styles from './fleet-host.module.css';

export function FleetHostPane({ visible }: Pick<PaneProps, 'visible'>) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const active = visible && sectionVisible && documentVisible;
  const read = useQuery(opsRunsQuery, { enabled: active, freshMs: 0 });
  const refetch = useRefetch(opsRunsQuery);
  const refresh = useRefresh(opsRunsQuery);
  usePollWhileVisible(refetch, 5_000, { enabled: visible, refreshOnShow: false });
  const data = read.data;
  const host = hostView(data ?? null, Date.now());

  return <div className={styles.pane} aria-label="Mac host">
    <header className={styles.header}>
      <p className={styles.headline}>Fleet Mac health</p>
      <button type="button" className={styles.refresh} onClick={refresh}>Refresh</button>
    </header>
    {data === null ? <p className={styles.muted}>The fleet runs API has not landed in this build yet.</p>
      : !data ? <p className={styles.muted} role="status">{read.status === 'error' ? 'Fleet runs are unavailable.' : 'Reading fleet runs…'}</p>
      : <>
        {read.status === 'error' ? <p className={styles.muted} role="status">Fleet runs could not refresh. Showing the last reading.</p> : null}
        {data.sources.runsDir !== 'healthy' ? <p className={styles.muted}>Runs directory: {data.sources.runsDir}</p> : null}
        {host.paused === true ? <p className={styles.banner} role="status">Fleet is paused.</p> : null}
        {host.paused === null ? <p className={styles.muted}>Pause status unknown.</p> : null}
        {host.load.tone === 'bad' ? <p className={styles.banner} role="status">Workers are starving for CPU; lower lane targets in the Lanes pane.</p> : null}
        <div className={styles.metrics}>
          <div className={styles.metric} data-tone={host.load.tone}><StatTile label="CPU load" value={host.load.text} caption={host.load.caption} /></div>
          <div className={styles.metric} data-tone={host.memory.pct === null ? 'unknown' : host.memory.tone}>
            <Gauge title="Memory free" value={host.memory.pct === null ? null : host.memory.pct / 100} showState={false} caption={host.memory.pct === null ? 'Unknown' : host.memory.tone} size={144} />
          </div>
          <div className={styles.metric} data-tone={host.disk.gb === null ? 'unknown' : host.disk.tone}><StatTile label="Disk free" value={host.disk.text} caption={host.disk.gb === null ? 'Unknown' : host.disk.tone} /></div>
          <div className={styles.metric} data-tone={host.tick.ageSeconds === null ? 'unknown' : host.tick.tone}><StatTile label="Orchestrator tick" value={host.tick.text} caption={host.tick.ageSeconds === null ? 'Unknown' : host.tick.tone} /></div>
        </div>
        <section className={styles.section} aria-label="Switches">
          <h3 className={styles.title}>Switches</h3>
          {host.switches.length ? <ul className={styles.switches}>{host.switches.map((item, i) => <li className={styles.badge} key={`${item}:${i}`}>{item}</li>)}</ul> : <p className={styles.muted}>No switches set</p>}
        </section>
        <section className={styles.section} aria-label="Claude lane">
          <h3 className={styles.title}>Claude lane</h3>
          <p className={styles.line} data-tone={host.claudeLane.down ? 'bad' : undefined}>{host.claudeLane.text}</p>
          {host.claudeLane.down ? <p className={styles.line}>Run <code>~/.ashlr-runs/bin/fix-claude-lane.sh</code></p> : null}
        </section>
        <p className={styles.muted}>Orchestrator agents: {host.orchestratorAgents ?? '—'}</p>
      </>}
  </div>;
}
