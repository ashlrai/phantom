/**
 * Home's This Mac card, on the desktop and the phone: what is using this Mac right now.
 * Built only on the `phm host top --json` report (host.top.v1). Read-only: it suggests, and has no button.
 */
import { describeHostTop, hostDiskWarningLine, hostTopMemory, type HostTopReport } from '../../../../core/fleet/host-top-view.js';
import { apiGet, ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './this-mac.module.css';

export const HOST_TOP_PATH = '/api/verse/fleet/memory/host-top';
const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const known = (value: unknown): boolean => value === null || count(value);
/** The free-disk trend, as this server sends it; an older server ships no disk at all, which still reads fine. */
const knownDisk = (value: unknown): boolean => value === undefined || (!!value && typeof value === 'object' && !Array.isArray(value)
  && known((value as Record<string, unknown>).freeGb) && known((value as Record<string, unknown>).gbPerHour)
  && ['falling', 'flat', 'rising', 'unknown'].includes(String((value as Record<string, unknown>).direction))
  && count((value as Record<string, unknown>).floorGb) && known((value as Record<string, unknown>).hoursToFloor)
  && count((value as Record<string, unknown>).warnUnderHours)
  && [null, 'below-floor', 'under-warn-hours'].includes((value as Record<string, unknown>).warning as string | null)
  && count((value as Record<string, unknown>).samples)
  && ((value as Record<string, unknown>).observedAt === null || typeof (value as Record<string, unknown>).observedAt === 'string'));

/** Accepts only a well-formed host.top.v1 report; anything else (an older server, another payload) is no reading. */
export function narrowHostTop(raw: unknown): HostTopReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>, host = r.host as Record<string, unknown> | null, suggestion = r.suggestion as Record<string, unknown> | null;
  if (r.schema !== 'host.top.v1' || r.version !== 1 || !host || typeof host !== 'object' || !suggestion || typeof suggestion.line !== 'string' ||
      !known(host.load1) || !known(host.load5) || !known(host.cores) || !known(host.swapUsedGb) || !(host.pressure === null || typeof host.pressure === 'string') ||
      !knownDisk(host.disk) ||
      !Array.isArray(r.buckets) || r.buckets.length > 32 || !Array.isArray(r.gaps)) return null;
  for (const bucket of r.buckets as Array<Record<string, unknown> | null>) {
    if (!bucket || typeof bucket.id !== 'string' || typeof bucket.name !== 'string' || !count(bucket.cpuPercent) || !count(bucket.rssMb) || !count(bucket.processes) || !count(bucket.sharePercent)) return null;
  }
  return raw as HostTopReport;
}

export const hostTopQuery: QueryDef<HostTopReport | null> = {
  key: 'verse-fleet-host-top',
  async fetch(signal) {
    try { return narrowHostTop(await apiGet<unknown>(HOST_TOP_PATH, signal)); }
    catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
  },
};

/** The top three buckets as bars, each as wide as its share of this Mac, over the one-line suggestion. */
export function ThisMacCard({ visible = true, className = '' }: { visible?: boolean; className?: string }) {
  const read = useQuery(hostTopQuery, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(hostTopQuery);
  usePollWhileVisible(refresh, 30_000, { enabled: visible });
  const report = narrowHostTop(read.data);
  // Before the first read, or on an older server, the card stays hidden.
  if (!report) return null;
  const top = report.buckets.filter(bucket => bucket.processes > 0).slice(0, 3);
  return <section className={`${styles.card} ${className}`} aria-label="This Mac">
    <h3 className={styles.title}>This Mac</h3>
    {read.status === 'error' ? <p className={styles.muted} role="status">This Mac could not refresh. Showing the last reading.</p> : null}
    <p className={styles.line}>{report.suggestion.line}</p>
    {top.length ? <ul className={styles.bars} aria-label="Biggest users">{top.map(bucket => <li key={bucket.id}>
      <span className={styles.name}>{bucket.name}</span>
      <span className={styles.muted}>{hostTopMemory(bucket.rssMb)} · {Math.round(bucket.cpuPercent)}% CPU</span>
      <span className={styles.track} role="img" aria-label={`${bucket.name}: ${bucket.sharePercent}% of this Mac`}>
        <span className={styles.fill} style={{ width: `${Math.max(2, Math.min(100, bucket.sharePercent))}%` }} />
      </span>
    </li>)}</ul> : null}
    <p className={styles.muted} data-pressure={report.host.pressure ?? 'unknown'}>{describeHostTop(report.host)}</p>
    {hostDiskWarningLine(report.host.disk) ? <p className={styles.muted} data-disk-warning="true">{hostDiskWarningLine(report.host.disk)}</p> : null}
  </section>;
}
