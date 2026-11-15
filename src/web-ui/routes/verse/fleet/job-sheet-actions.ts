import { prLabel, safePrUrl } from '../fleet-job-log/worker-log-model.js';

type Action = { id: 'log' | 'pr' | 'steer' | 'stop'; label: string; href?: string };
type Detail = { publish?: { prUrl?: string | null } | null } | null | undefined;

export function steerPrefill(job: string, lane?: string | null): string {
  return `Re ${job}${lane ? ` (${lane})` : ''}: `;
}

export function sheetActions(_job: string, detail: Detail, state?: string): Action[] {
  const actions: Action[] = [{ id: 'log', label: 'Open worker log' }];
  const url = safePrUrl(detail?.publish?.prUrl);
  if (url && new URL(url).protocol === 'https:') actions.push({ id: 'pr', label: `Open ${prLabel(url)}`, href: url });
  actions.push({ id: 'steer', label: 'Steer this worker' });
  if (state === 'running') actions.push({ id: 'stop', label: 'Stop this job' });
  return actions;
}
