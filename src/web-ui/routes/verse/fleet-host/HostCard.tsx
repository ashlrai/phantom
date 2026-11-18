/**
 * Host card: `phm host` in the Fleet host pane (GET /api/verse/fleet/host,
 * phantom.host.v1). Answers "what is using this machine?" in plain words:
 * load, memory, how much CPU is the fleet's, the busiest program groups and
 * orphaned job processes. Unknown readings say unknown; nothing is inferred
 * here, every number comes from the API.
 */
import type { HostGroup, HostReportV1 } from '../../../../core/fleet/host-top.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { hostTopQuery } from './host-top-query.js';
import styles from './fleet-host.module.css';

const value = (n: number | null, unit = ''): string => n === null ? 'unknown' : `${n}${unit}`;
const cores = (percent: number | null): string => percent === null ? 'unknown' : `${(percent / 100).toFixed(1)} cores`;
const age = (s: number | null): string => s === null ? 'age unknown'
  : s < 3600 ? `${Math.max(1, Math.floor(s / 60))}m` : s < 86_400 ? `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m` : `${Math.floor(s / 86_400)}d ${Math.floor(s / 3600) % 24}h`;

function loadLine(r: HostReportV1): { text: string; tone: 'ok' | 'warn' | 'bad' | 'unknown' } {
  const { load1, cpuCount } = r.load;
  if (load1 === null || !cpuCount) return { text: 'Load unknown', tone: 'unknown' };
  const ratio = load1 / cpuCount;
  return { text: `Load ${load1.toFixed(1)} on ${cpuCount} CPUs`, tone: ratio < 1.5 ? 'ok' : ratio < 4 ? 'warn' : 'bad' };
}

function cpuLine(r: HostReportV1): string {
  const p = r.processes;
  if (p.state === 'unknown') return `Processes unknown: ${p.reason === 'ps-denied' ? 'ps is not permitted here' : 'ps could not be read'}`;
  const share = p.fleetShare === null ? '' : ` (${Math.round(p.fleetShare * 100)}%)`;
  return `Fleet ${cores(p.fleetCpuPercent)}${share} · not fleet ${cores(p.otherCpuPercent)}`;
}

const groupLine = (g: HostGroup): string =>
  `${g.label} · ${g.fleet ? 'fleet' : 'not fleet'} · ${cores(g.cpuPercent)} · ${(g.rssBytes / 1024 ** 3).toFixed(1)} GB · ${g.processes} ${g.processes === 1 ? 'process' : 'processes'}`;

export function HostCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(hostTopQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 0 });
  const refetch = useRefetch(hostTopQuery);
  usePollWhileVisible(refetch, 10_000, { enabled: visible, refreshOnShow: false });
  const r = read.data;
  if (!r) return null;
  const load = loadLine(r);
  return <section className={styles.section} aria-label="Host">
    <h3 className={styles.title}>Host</h3>
    {read.status === 'error' ? <p className={styles.muted} role="status">Host could not refresh. Showing the last reading.</p> : null}
    <p className={styles.metric} data-tone={load.tone}>{load.text}</p>
    <p className={styles.line}>Memory {value(r.memory.freePercent, '%')} free · swap {value(r.memory.swapGb, ' GB')}</p>
    <p className={styles.line}>{cpuLine(r)}</p>
    {r.topCpu?.length ? <ul className={styles.peerList} aria-label="Busiest">{r.topCpu.map(g =>
      <li className={styles.line} data-tone={g.fleet ? undefined : 'warn'} key={`${g.family}:${g.fleet}`}>{groupLine(g)}</li>)}</ul> : null}
    {r.orphans === null ? null : r.orphans.length === 0 ? <p className={styles.muted}>Orphans: none</p> : <>
      <p className={styles.line} data-tone="warn">Orphans: {r.orphanCount}</p>
      <ul className={styles.peerList} aria-label="Orphans">{r.orphans.slice(0, 10).map(o =>
        <li className={styles.line} key={o.pid}>{o.job} · {o.name} pid {o.pid} · {o.reason === 'worktree-gone' ? 'worktree gone' : 'parent is launchd'} · {age(o.ageSeconds)}</li>)}</ul>
    </>}
  </section>;
}
