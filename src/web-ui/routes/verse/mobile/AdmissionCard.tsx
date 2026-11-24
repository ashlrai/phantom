import { useQuery, useRefetch } from '../../../data/hooks.js';
import { fleetAdmissionQuery } from '../fleet-hub/fleet-admission-query.js';
import { hostLoadQuery } from '../fleet-host/host-load-query.js';
import { useDocumentVisible, usePollWhileVisible } from '../shell/section-visibility.js';
import { Row, Section } from './ui-parts.js';

export function AdmissionCard() {
  const visible = useDocumentVisible();
  const admission = useQuery(fleetAdmissionQuery, { enabled: visible, freshMs: 0 });
  const host = useQuery(hostLoadQuery, { enabled: visible, freshMs: 0 });
  const refreshAdmission = useRefetch(fleetAdmissionQuery);
  const refreshHost = useRefetch(hostLoadQuery);
  usePollWhileVisible(refreshAdmission, 5_000);
  usePollWhileVisible(refreshHost, 15_000);
  const now = Date.now();
  const fresh = (at: number) => Number.isFinite(at) && at <= now && now - at <= 300_000;
  const data = admission.status !== 'error' && admission.data?.state !== 'unknown'
    && admission.data?.ts != null && fresh(admission.data.ts * 1000) ? admission.data : null;
  const load = host.status !== 'error' && host.data?.state === 'known'
    && fresh(Date.parse(host.data.generatedAt)) ? host.data : null;
  const top = load?.groups.reduce<(typeof load.groups)[number] | null>(
    (best, group) => group.cpuPercent > (best?.cpuPercent ?? 0) ? group : best, null);
  const count = (n: number | null | undefined) => n != null && Number.isSafeInteger(n) && n >= 0 ? String(n) : 'unknown';
  const seconds = data?.nextStartSeconds;
  return <Section title="Why jobs are waiting">
    <Row title="Running" subtitle={`${count(data?.total_running)} of ${count(data?.max_total_running)}`} />
    <Row title="Reason" subtitle={typeof data?.reason === 'string' ? data.reason : 'unknown'} />
    <Row title="Next start" subtitle={data && data.state !== 'blocked' && seconds != null ? `~${count(seconds)} sec` : 'unknown'} />
    <Row title="Host load top cause" subtitle={top ? `${top.name} (${top.cpuPercent}% CPU)` : 'unknown'} />
  </Section>;
}
