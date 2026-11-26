import { homedir } from 'node:os';
import { join } from 'node:path';
import { devinCliLaneVerdict, type DevinCliLaneInput } from '../devin/cli-engine.js';
import { defaultDevinCliCandidates, probeDevinCli } from '../devin/cli-probe.js';
import { resolveExecutable } from '../run/tool-path.js';
import { defaultResourceLiveSources } from '../usage/resource-live/sources.js';
import { RESOURCE_LIVE_STALE_MS } from '../usage/resource-live/types.js';
import { readZaiUsage } from '../usage/zai-usage.js';

type Lane = 'agy-neon' | 'devin-flash' | 'glm-lite';
type Reading = { evidence: 'unknown' | 'observed' | 'exhausted'; resetAt: string | null; reason?: string };
type ProbeDeps = {
  now?: () => number;
  readAgy?: (now: number) => Promise<{ used: number | null; reset_at: string | null; window_start?: string } | null>;
  readAgyDenial?: () => Promise<{ status: number; message: string } | null>;
  readZai?: typeof readZaiUsage;
  probeDevin?: typeof probeDevinCli;
  devinAdmission?: Omit<DevinCliLaneInput, 'probe' | 'model'>;
};

const unknown: Reading = { evidence: 'unknown', resetAt: null };
const future = (value: string | null, now: number) => value && Date.parse(value) > now
  ? new Date(value).toISOString() : null;

function agyReset(message: string, now: number) {
  const stamp = /\b(?:reset(?:s)?(?:\s+at)?|try again(?:\s+at)?)\s*[:=]?\s*(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))\b/i.exec(message)?.[1];
  return future(stamp ?? null, now);
}

async function readLane(lane: Lane, deps: ProbeDeps): Promise<Reading> {
  const now = (deps.now ?? Date.now)();
  if (lane === 'agy-neon') {
    const denial = await deps.readAgyDenial?.();
    if (denial?.status === 429 && /\bIndividual quota reached\b/i.test(denial.message)) {
      return { evidence: 'exhausted', resetAt: agyReset(denial.message, now), reason: 'agy_quota_exhausted' };
    }
    const runsDir = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
    const read = await (deps.readAgy ?? (async time => {
      const row = await defaultResourceLiveSources({ runsDir }).antigravity?.[0]?.read(time);
      return row && 'used' in row ? row : null;
    }))(now);
    const resetAt = future(read?.reset_at ?? null, now);
    return resetAt && read?.used != null && Date.parse(resetAt) - Date.parse(read.window_start ?? '') === 5 * 60 * 60_000
      ? { evidence: read.used >= 100 ? 'exhausted' : 'observed', resetAt } : unknown;
  }
  if (lane === 'glm-lite') {
    const read = await (deps.readZai ?? readZaiUsage)();
    const resetAt = future(read?.resetsAt ?? null, now);
    const age = now - Date.parse(read?.asOf ?? '');
    return resetAt && read?.used != null && age >= 0 && age < RESOURCE_LIVE_STALE_MS
      ? { evidence: read.used >= 100 ? 'exhausted' : 'observed', resetAt } : unknown;
  }
  const cli = resolveExecutable('devin');
  const probe = await (deps.probeDevin ?? probeDevinCli)({
    cliCandidates: cli ? [cli.path, ...defaultDevinCliCandidates()] : defaultDevinCliCandidates(),
  });
  if (!deps.devinAdmission) return probe.reason ? { ...unknown, reason: probe.reason } : unknown;
  const verdict = devinCliLaneVerdict({ ...deps.devinAdmission, probe, model: 'swe-2-flash-max' });
  if (!verdict.ok) return { ...unknown, reason: verdict.reason };
  return { evidence: 'observed', resetAt: null };
}

export async function inspectSwarmFleetLane(id: string, deps: ProbeDeps = {}) {
  if (id !== 'agy-neon' && id !== 'devin-flash' && id !== 'glm-lite') return null;
  const reading = await readLane(id, deps).catch(() => unknown);
  return { lane: id, ...reading, readiness: reading.evidence === 'unknown' ? 'unknown' : 'held',
    dispatch: 'bridge-not-commissioned' } as const;
}
