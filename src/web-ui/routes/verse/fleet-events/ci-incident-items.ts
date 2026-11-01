import type { FeedItem } from './fleet-events-model.js';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

export function ciIncidentItem(envelope: { id: string; body: unknown }, at: string): FeedItem | null {
  const body = record(envelope.body);
  if (typeof body.kind !== 'string' || !body.kind.startsWith('ci.') || typeof body.repo !== 'string'
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$(?![\s\S])/.test(body.repo)
      || typeof body.runId !== 'number' || !Number.isSafeInteger(body.runId) || body.runId <= 0) return null;

  const prefix = `https://github.com/${body.repo}/actions/runs/`;
  const url = typeof body.url === 'string' && body.url.startsWith(prefix) ? body.url : `${prefix}${body.runId}`;
  let text: string;
  if (body.kind === 'ci.failed-scheduled-run') {
    const workflow = typeof body.workflow === 'string' && body.workflow ? ` ${body.workflow}` : '';
    text = `CI failed: ${body.repo}${workflow} run ${body.runId}`;
    if (typeof body.attempt === 'number' && Number.isSafeInteger(body.attempt) && body.attempt > 1) text += `, attempt ${body.attempt}`;
    if (Array.isArray(body.jobs) && body.jobs.length) {
      const names = body.jobs.slice(0, 2).map(job => record(job).name)
        .filter((name): name is string => typeof name === 'string').map(name => name.slice(0, 40));
      const count = typeof body.failedJobCount === 'number' && Number.isSafeInteger(body.failedJobCount) && body.failedJobCount >= 0
        ? body.failedJobCount : body.jobs.length;
      text += ` · ${count} job(s): ${names.join(', ')}`;
    }
  } else {
    text = `CI ${body.kind.slice(3)}: ${body.repo} run ${body.runId}`;
  }
  return { id: `bus:${envelope.id}`, kind: 'ci', at, text, url };
}
