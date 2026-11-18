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
const query: QueryDef<ShippedReport> = { key: 'shipped', fetch: signal => apiGet(SHIPPED_PATH, signal) };
/** The card is a glance; `phm shipped` and the docs page hold the longer list. */
const LINES_PER_AREA = 2;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Only a well-formed shipped.v1 payload is a report. */
function reportOf(data: unknown): ShippedReport | null {
  if (data === null || typeof data !== 'object') return null;
  const report = data as Partial<ShippedReport>;
  return report.schema === 'shipped.v1' && Array.isArray(report.areas) ? report as ShippedReport : null;
}

export function ShippedCard({ visible = true }: { visible?: boolean }) {
  const read = useQuery(query, { enabled: visible });
  const report = reportOf(read.data);
  const window = `the last ${plural(report?.days ?? 7, 'day')}`;
  let body;
  if (read.status === 'error' && !report) body = <p data-unknown>Unknown: what shipped could not be read.</p>;
  // Before the first read, or any other payload (an older server), the card stays hidden.
  else if (!report) return null;
  else if (report.total === null) body = <p data-unknown>Unknown: {report.note ?? 'what shipped could not be read.'}</p>;
  else if (report.total === 0) body = <p>Nothing merged in {window}.</p>;
  else {
    const maintenance = report.maintenance ?? 0;
    body = <>
      <p>{plural(report.total - maintenance, 'change')} in {window}.</p>
      {report.areas.map(area => <ul key={area.id} aria-label={area.label}>
        <li><strong>{area.label}: {area.count}</strong></li>
        {area.lines.slice(0, LINES_PER_AREA).map(line => <li key={`${line.mergedAt} ${line.number} ${line.text}`}>{line.text}</li>)}
        {area.count > LINES_PER_AREA && <li>and {area.count - LINES_PER_AREA} more</li>}
      </ul>)}
      {maintenance > 0 && <p>Maintenance: {plural(maintenance, 'change')} (tests and chores).</p>}
      {report.note && <p data-unknown>{report.note}</p>}
      <p>For the full list, run <code className={styles.command}>phm shipped</code></p>
    </>;
  }
  return <section className={styles.card} aria-label="Shipped"><h3>Shipped</h3>{body}</section>;
}
