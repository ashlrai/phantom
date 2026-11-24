/**
 * Home's Shipped card: what merged in the last week, in plain words by product
 * area. Built only on the `phm shipped --json` report (shipped.v1). Read-only.
 */
import type { ShippedReport } from '../../../../core/release/shipped.js';
import { apiGet } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import styles from './home.module.css';

export const SHIPPED_PATH = '/api/verse/shipped';
/** One cached read per window: the week on desktop Home, one day ("today") on the phone. */
export const shippedQuery = (days: number): QueryDef<ShippedReport> => ({ key: `shipped-${days}`, fetch: signal => apiGet(`${SHIPPED_PATH}?days=${days}`, signal) });
/** The card is a glance; `phm shipped` and the docs page hold the longer list. */
const LINES_PER_AREA = 2;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Only a well-formed shipped.v1 payload is a report. */
function reportOf(data: unknown): ShippedReport | null {
  if (data === null || typeof data !== 'object') return null;
  const report = data as Partial<ShippedReport>;
  return report.schema === 'shipped.v1' && Array.isArray(report.areas) ? report as ShippedReport : null;
}

export function ShippedCard({ visible = true, days = 7 }: { visible?: boolean; days?: number }) {
  const read = useQuery(shippedQuery(days), { enabled: visible });
  const report = reportOf(read.data);
  const today = (report?.days ?? days) === 1;
  const failed = Boolean(read.error) || read.status === 'error';
  const stale = failed && report !== null;
  const lastSuccess = typeof read.updatedAt === 'number' ? new Date(read.updatedAt).toISOString() : null;
  const window = today ? 'the last 24 hours' : `the last ${plural(report?.days ?? days, 'day')}`;
  let body;
  if (failed && !report) body = <p role="status">What shipped is unavailable right now. Try again.</p>;
  // Before the first read, or any other payload (an older server), the card stays hidden.
  else if (!report) return null;
  else if (report.total === null) body = <p data-unknown>Unknown: {report.note ?? 'what shipped could not be read.'}</p>;
  else if (report.total === 0) body = <p>Nothing merged in {window}.</p>;
  else {
    const maintenance = report.maintenance ?? 0;
    body = <>
      {/* The report's own top line; a server from before it existed still gets the plain count. */}
      <p>{report.headline ?? `${plural(report.total - maintenance, 'change')} in ${window}.`}</p>
      {report.areas.map(area => <ul key={area.id} aria-label={area.label}>
        <li><strong>{area.label}: {area.count}</strong></li>
        {area.lines.slice(0, LINES_PER_AREA).map(line => <li key={`${line.mergedAt} ${line.number} ${line.text}`}>{line.text}</li>)}
        {area.count > LINES_PER_AREA && <li>and {area.count - LINES_PER_AREA} more</li>}
      </ul>)}
      {maintenance > 0 && <p>Maintenance: {plural(maintenance, 'change')} (tests and chores).</p>}
      {report.note && <p data-unknown>{report.note}</p>}
      <p>For the full list, run <code className={styles.command}>phm shipped{today ? ' --since 1d' : ''}</code></p>
    </>;
  }
  return <section className={styles.card} aria-label={today ? 'Shipped today' : 'Shipped'}>
    <h3>{today ? 'Shipped today' : 'Shipped'}</h3>
    {stale ? <p role="status">Refresh failed; showing the last shipped report, which may be stale. Last successful update:{' '}
      {lastSuccess === null ? 'time unavailable' : <time dateTime={lastSuccess}>{lastSuccess}</time>}.</p> : null}
    {body}
  </section>;
}
