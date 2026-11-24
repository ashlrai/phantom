/**
 * routes/verse/leader/PhoneUpdatesLine.tsx — one row on the Leader card: "Phone updates: off (iMessage not set up)".
 * Built only on the typed owner-live.status.v1 report (`phm owner-live status --json`); the line text is
 * the report's own `line`, so the panel and the CLI always say the same thing. Draws nothing when the report
 * is missing. Plain text, read-only.
 */
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { OwnerLiveStatusV1 } from '../../../../core/comms/owner-live-status.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';

export const OWNER_LIVE_PATH = '/api/verse/fleet/runs/owner-live';
export const ownerLiveQuery: QueryDef<OwnerLiveStatusV1 | null> = {
  key: 'owner-live-status',
  fetch: async signal => {
    const body = await apiGet<Partial<OwnerLiveStatusV1>>(OWNER_LIVE_PATH, signal);
    return body.schema === 'owner-live.status.v1' && typeof body.line === 'string' ? body as OwnerLiveStatusV1 : null;
  },
};

export function PhoneUpdatesLine({ className }: { className?: string }) {
  const query = useQuery(ownerLiveQuery, { freshMs: 30_000 });
  const refetch = useRefetch(ownerLiveQuery);
  usePollWhileVisible(refetch, 60_000);
  const report = query?.data ?? null;
  if (report === null) return null;
  const next = report.channels.find(c => c.state !== 'on')?.nextStep;
  return <p className={className} role="status" data-tone={report.anyOn ? 'ok' : 'warn'}>
    {report.line}{report.anyOn || !next ? '' : `. Next: ${next}`} <code>phm owner-live status</code>
  </p>;
}
