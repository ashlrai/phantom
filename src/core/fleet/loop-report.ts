import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { collectLoopGithub, loopGh, type LoopGh } from './loop-github.js';
import { loopCosts, loopWindowEnd, parseCiTimes, parseLoopQueue } from './loop-inputs.js';
import { LOOP_STAGES, row, summarizeLoop, type LoopReport, type Row } from './loop.js';

const MAX_BYTES = 8 * 1024 * 1024;
export interface LoopOptions {
  fleetPath?: string;
  queuePath?: string;
  ciPath?: string;
  now?: number;
  gh?: LoopGh;
  posthogToken?: string;
  posthogHost?: string;
  fetch?: typeof fetch;
}
function readText(path: string): string | null {
  const result = readStableRegularFile(resolve(path), { anchorPath: dirname(resolve(path)), maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
  return result.ok ? result.text : null;
}
function readFleet(path: string): Row {
  const text = readText(path);
  if (text === null) {
    try { lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    }
    throw new Error('fleet-state-unavailable-or-unsafe');
  }
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return row(value);
  } catch { throw new Error('fleet-state-invalid'); }
}
export function loopEvents(report: LoopReport): { event: string; timestamp: string; properties: Row }[] {
  const common = { distinct_id: 'phantom-fleet-loop', $process_person_profile: false, schema: report.schema, window_days: 7, complete: report.complete };
  return [
    ...LOOP_STAGES.map(stage => ({ event: 'phantom_loop_stage', timestamp: report.generated_at,
      properties: { ...common, stage, ...report.stages[stage] } })),
    { event: 'phantom_loop_bottleneck', timestamp: report.generated_at,
      properties: { ...common, stage: report.bottleneck.stage, p90_ms: report.bottleneck.p90_ms, provisional: report.bottleneck.provisional } },
  ];
}
export async function emitLoopEvents(report: LoopReport, options: Pick<LoopOptions, 'posthogToken' | 'posthogHost' | 'fetch'>): Promise<LoopReport['telemetry']> {
  if (!options.posthogToken) return 'disabled';
  // Fixed ingest hosts prevent leaking the project token through an accidental URL/redirect.
  const host = options.posthogHost ?? 'https://us.i.posthog.com';
  if (!/^https:\/\/(?:us|eu)\.i\.posthog\.com\/?$/.test(host)) return 'failed';
  try {
    const response = await (options.fetch ?? fetch)(`${host.replace(/\/$/, '')}/batch/`, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: options.posthogToken, batch: loopEvents(report) }), signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? 'sent' : 'failed';
  } catch { return 'failed'; }
}

/** Refresh only the loop key. Re-read after network IO to preserve newer fleet fields. */
export async function refreshLoopReport(options: LoopOptions = {}): Promise<LoopReport> {
  const path = resolve(options.fleetPath ?? process.env['PHANTOM_FLEET_PATH'] ?? '/workspace/phantom-work/fleet.json');
  const wallClock = options.now ?? Date.now();
  if (!Number.isFinite(wallClock) || wallClock < 7 * 86400_000 || wallClock > 8.64e15) throw new Error('invalid-loop-clock');
  // Only ENOENT permits a new fleet file. Corrupt/unsafe existing state is never replaced.
  const fleet = readFleet(path);
  const now = loopWindowEnd(fleet, wallClock);
  const queue = readText(options.queuePath ?? process.env['PHANTOM_ROUTER_QUEUE_PATH'] ?? join(dirname(path), 'router-queue.md'));
  const ci = readText(options.ciPath ?? process.env['PHANTOM_CI_TIME_PATH'] ?? join(dirname(path), 'ci-efficiency', 'ci-time-per-pr.jsonl'));
  const claims = queue === null ? { values: [], complete: false } : parseLoopQueue(queue);
  const ledger = ci === null ? { values: [], complete: false } : parseCiTimes(ci);
  const github = await collectLoopGithub(options.gh ?? loopGh, claims.values, ledger.values, now, wallClock);
  const costs = loopCosts(fleet, github.prs, now);
  const report = summarizeLoop(now, github.prs, [
    ...github.sources,
    { source: 'router-queue.md', complete: claims.complete, reason: claims.complete ? null : 'unavailable-invalid-or-incomplete' },
    { source: 'ci_time.v1', complete: ledger.complete, reason: ledger.complete ? null : 'unavailable-invalid-or-incomplete' },
    { source: 'fleet.json:spend', complete: costs.complete, reason: costs.complete ? null : 'missing-window-aligned-usd-or-points' },
  ], github.repos, costs.cost);
  report.generated_at = new Date(wallClock).toISOString();
  // Persist before sending telemetry: a state write failure must not emit a successful refresh.
  persistLoop(path, report);
  report.telemetry = await emitLoopEvents(report, {
    ...options,
    posthogToken: options.posthogToken ?? process.env['PHANTOM_POSTHOG_TOKEN'],
    posthogHost: options.posthogHost ?? process.env['PHANTOM_POSTHOG_HOST'],
  });
  if (report.telemetry !== 'disabled') persistLoop(path, report);
  return report;
}
function persistLoop(path: string, report: LoopReport): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const latest = readFleet(path);
  if (String(row(latest['loop'])['generated_at'] ?? '') > report.generated_at) return;
  writePrivateFileAtomically(`${path}.${randomUUID()}.tmp`, path, JSON.stringify({ ...latest, loop: report }, null, 2) + '\n',
    { anchorPath: directory, label: 'loop snapshot' });
}
