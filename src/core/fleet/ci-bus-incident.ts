/** A bounded, read-only GitHub observation translated into a durable bus incident. */
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { CloudGh } from '../cloud/pr-actions.js';
import { scrubSecrets } from '../util/scrub-secrets.js';
import { defaultGitRunner } from '../verse/git-ops.js';
import { validateBusEnvelope, type BusEnvelope } from './bus-envelope.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxOptions } from './bus-inbox.js';

// Seven days from receipt, long enough for an offline agent to catch up.
export const CI_INCIDENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_GH_BYTES = 1024 * 1024;
const MAX_JOBS = 100;
const SHOWN_JOBS = 10;
const SHOWN_STEPS = 10;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeText = (value: string): string => scrubSecrets(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 100);

export function validCiPublishInput(repo: string, run: string, to: string): boolean {
  return REPO.test(repo) && scrubSecrets(repo) === repo && /^[1-9]\d*$/.test(run) && positive(Number(run)) &&
    scrubSecrets(to) === to && validateBusEnvelope({ id: 'ci', from: 'ci', to, priority: 'P1', ttl: 1, body: null }).ok;
}

const defaultGh: CloudGh = async args => {
  const result = await defaultGitRunner('gh', args, { cwd: tmpdir(), timeoutMs: 30_000, maxStdoutBytes: MAX_GH_BYTES });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: '' };
};

async function read(gh: CloudGh, endpoint: string): Promise<unknown> {
  const result = await gh(['api', '--hostname', 'github.com', '--method', 'GET', endpoint]);
  if (!result.ok || Buffer.byteLength(result.stdout, 'utf8') > MAX_GH_BYTES) throw new Error('read');
  return JSON.parse(result.stdout) as unknown;
}

type Result =
  | { status: 'skipped'; reason: string }
  | { status: 'error'; reason: string }
  | { status: 'dry-run'; envelope: BusEnvelope }
  | { status: 'posted' | 'duplicate'; id: string; cursor: number };

export async function publishCiIncident(input: { repo: string; run: string; to: string; dryRun: boolean },
  deps: { gh?: CloudGh; bus?: BusInboxOptions } = {}): Promise<Result> {
  const { run, to, dryRun } = input;
  if (!validCiPublishInput(input.repo, run, to)) return { status: 'error', reason: 'invalid input' };
  const repo = input.repo.toLowerCase(), gh = deps.gh ?? defaultGh;
  let source: unknown;
  try { source = await read(gh, `repos/${repo}/actions/runs/${run}`); }
  catch { return { status: 'error', reason: 'GitHub run read failed' }; }
  if (!record(source) || source.id !== Number(run) || !record(source.repository) ||
      typeof source.repository.full_name !== 'string' || source.repository.full_name.toLowerCase() !== repo ||
      typeof source.event !== 'string' || typeof source.status !== 'string' ||
      !(typeof source.conclusion === 'string' || source.conclusion === null)) {
    return { status: 'error', reason: 'invalid GitHub run response' };
  }
  if (source.event !== 'schedule') return { status: 'skipped', reason: 'run event is not schedule' };
  if (source.status !== 'completed') return { status: 'skipped', reason: 'run is not completed' };
  if (source.conclusion !== 'failure') return { status: 'skipped', reason: 'run conclusion is not failure' };
  if (!positive(source.run_attempt) || typeof source.name !== 'string' || !source.name ||
      typeof source.head_branch !== 'string' || !source.head_branch || typeof source.head_sha !== 'string' ||
      !/^[a-fA-F0-9]{40}$/.test(source.head_sha)) return { status: 'error', reason: 'invalid GitHub run metadata' };
  const attempt = source.run_attempt;
  let response: unknown;
  try { response = await read(gh, `repos/${repo}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`); }
  catch { return { status: 'error', reason: 'GitHub jobs read failed' }; }
  if (!record(response) || !Number.isSafeInteger(response.total_count) || typeof response.total_count !== 'number' ||
      response.total_count < 0 || response.total_count > MAX_JOBS || !Array.isArray(response.jobs) ||
      response.jobs.length !== response.total_count) return { status: 'error', reason: 'incomplete or invalid GitHub jobs response' };
  const jobs: { id: number; name: string; failedSteps: string[]; failedStepCount: number }[] = [];
  const ids = new Set<number>();
  for (const job of response.jobs as unknown[]) {
    if (!record(job) || !positive(job.id) || ids.has(job.id) || job.run_id !== Number(run) ||
        typeof job.conclusion !== 'string' || typeof job.name !== 'string' || !job.name) {
      return { status: 'error', reason: 'invalid GitHub job metadata' };
    }
    ids.add(job.id);
    if (job.conclusion !== 'failure') continue;
    if (!Array.isArray(job.steps) || job.steps.length > 1000) return { status: 'error', reason: 'invalid GitHub step metadata' };
    const steps: { number: number; name: string }[] = [];
    const numbers = new Set<number>();
    for (const step of job.steps as unknown[]) {
      if (!record(step) || !positive(step.number) || numbers.has(step.number) || typeof step.name !== 'string' ||
          !step.name || !(typeof step.conclusion === 'string' || step.conclusion === null)) {
        return { status: 'error', reason: 'invalid GitHub step metadata' };
      }
      numbers.add(step.number);
      if (step.conclusion === 'failure') steps.push({ number: step.number, name: safeText(step.name) });
    }
    steps.sort((a, b) => a.number - b.number);
    jobs.push({ id: job.id, name: safeText(job.name), failedSteps: steps.slice(0, SHOWN_STEPS).map(step => step.name), failedStepCount: steps.length });
  }
  jobs.sort((a, b) => a.id - b.id);
  const id = `ci-${createHash('sha256').update(JSON.stringify([repo, run, attempt, to])).digest('hex')}`;
  const checked = validateBusEnvelope({
    id, from: 'system:ci', to, priority: 'P1', ttl: CI_INCIDENT_TTL_MS,
    body: { kind: 'ci.failed-scheduled-run', repo, runId: Number(run), attempt,
      url: `https://github.com/${repo}/actions/runs/${run}/attempts/${attempt}`,
      workflow: safeText(source.name), branch: safeText(source.head_branch), headSha: source.head_sha.toLowerCase(),
      failedJobCount: jobs.length, jobs: jobs.slice(0, SHOWN_JOBS) },
  });
  if (!checked.ok) return { status: 'error', reason: 'invalid incident envelope' };
  if (dryRun) return { status: 'dry-run', envelope: checked.value };
  let posted = appendBusInbox(checked.value, deps.bus);
  // The inbox retains IDs forever and conflicts on changed content. Recover the
  // original receipt, including expired messages, without replacing its body.
  if (posted.status === 'conflict') {
    let after = 0;
    for (;;) {
      const page = listBusInboxAfter(after, 100, { ...deps.bus, now: () => 0 });
      if (page.status !== 'ok') return { status: 'error', reason: `bus storage ${page.status}` };
      const existing = page.messages.find(row => row.envelope.id === id);
      if (existing) {
        const old = existing.envelope, body = old.body;
        if (old.from !== 'system:ci' || old.to !== to || old.priority !== 'P1' || old.ttl !== CI_INCIDENT_TTL_MS ||
            !record(body) || body.kind !== 'ci.failed-scheduled-run' || body.repo !== repo ||
            body.runId !== Number(run) || body.attempt !== attempt) return { status: 'error', reason: 'bus storage conflict' };
        posted = appendBusInbox(old, deps.bus);
        break;
      }
      if (page.nextCursor === after) return { status: 'error', reason: 'bus storage conflict' };
      after = page.nextCursor;
    }
  }
  return posted.status === 'posted' || posted.status === 'duplicate'
    ? posted : { status: 'error', reason: `bus storage ${posted.status}` };
}
