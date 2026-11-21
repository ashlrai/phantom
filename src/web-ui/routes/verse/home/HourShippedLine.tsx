/**
 * One plain line, "Last hour: 5 shipped (3 fleet, 1 desktop/phone, 1 docs/site)", from the local-git feed
 * (`phm shipped --since 1h`, fleet.shipped.v1 with window "1h"). Shared by desktop Home and the phone.
 * Hidden until the first read and for any payload that is not the hour feed (an older server); a failed
 * read says unknown rather than "nothing shipped".
 */
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { HourShippedReport } from '../../../../core/fleet/shipped-hour.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';

export const HOUR_SHIPPED_PATH = '/api/verse/shipped?since=1h';
/** Null for anything that is not the hour feed (an older server, an error body). */
export const hourReportOf = (value: unknown): HourShippedReport | null => {
  const report = value as Partial<HourShippedReport> | null | undefined;
  return report?.schema === 'fleet.shipped.v1' && report.window === '1h' && typeof report.headline === 'string' ? report as HourShippedReport : null;
};
export const hourShippedQuery: QueryDef<HourShippedReport | null> = {
  key: 'fleet-shipped-hour',
  async fetch(signal) { return hourReportOf(await apiGet<unknown>(HOUR_SHIPPED_PATH, signal)); },
};

export function HourShippedLine({ visible = true, className }: { visible?: boolean; className?: string }) {
  const read = useQuery(hourShippedQuery, { enabled: visible });
  const refresh = useRefetch(hourShippedQuery);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const report = hourReportOf(read.data);
  if (report) return <p className={className} data-testid="hour-shipped" role="status">{report.headline}</p>;
  if (read.error || read.status === 'error') return <p className={className} data-testid="hour-shipped" role="status">Last hour: unknown (could not read git history).</p>;
  return null;
}
