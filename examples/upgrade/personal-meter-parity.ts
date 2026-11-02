#!/usr/bin/env -S npx tsx
/* global process */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_USAGE_STALE_MS } from '../../src/core/fleet/codex-session-usage.js';

const usage = 'npx tsx examples/upgrade/personal-meter-parity.ts [--help]';
type Command = 'ledger' | 'personal';
type Result = { code: number; stdout: string };
type Dependencies = {
  read: (command: Command) => Promise<Result>;
  now: () => number;
  write: (text: string) => void;
};

// Invoke the installed CLI so both projections come from the installation under test.
function readInstalled(command: Command): Promise<Result> {
  return new Promise((resolveRead, reject) => {
    execFile('phm', ['resources', command, '--json'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error && (typeof error.code !== 'number' || error.code !== 1)) return reject(error);
      resolveRead({ code: error ? 1 : 0, stdout });
    });
  });
}

const obj = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const instant = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const percent = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

/** Compare only complete, current, personal weekly readings from the same instant. */
export async function run(args: readonly string[], overrides: Partial<Dependencies> = {}): Promise<number> {
  const deps: Dependencies = { read: readInstalled, now: Date.now, write: text => process.stdout.write(text), ...overrides };
  const emit = (value: unknown) => deps.write(JSON.stringify(value) + '\n');
  if (args.length === 1 && args[0] === '--help') { emit({ v: 1, usage }); return 0; }
  if (args.length !== 0) { emit({ v: 1, error: 'invalid_arguments', usage }); return 2; }
  try {
    const [ledgerResult, personalResult] = await Promise.all([deps.read('ledger'), deps.read('personal')]);
    if (ledgerResult.code !== 0 || ![0, 1].includes(personalResult.code)) throw new Error('read failed');
    const ledger: unknown = JSON.parse(ledgerResult.stdout);
    const report: unknown = JSON.parse(personalResult.stdout);
    const lanes = obj(ledger) && ledger.v === 1 && Array.isArray(ledger.lanes) ? ledger.lanes.filter((row: unknown) => obj(row) && row.lane === 'codex-personal') : [];
    const resources = obj(report) && report.v === 'resource.v1' && Array.isArray(report.resources) ? report.resources.filter((row: unknown) => obj(row) && row.id === 'codex-personal') : [];
    const lane: unknown = lanes.length === 1 ? lanes[0] : null;
    const personal: unknown = resources.length === 1 ? resources[0] : null;
    const observation = obj(lane) && obj(lane.observation) ? lane.observation : null;
    const weekly = obj(personal) && obj(personal.weekly) ? personal.weekly : null;
    const ledgerAt = instant(observation?.asOf);
    const personalAt = instant(obj(personal) ? personal.observedAt : null);
    const ledgerReset = instant(obj(lane) ? lane.resetAt : null);
    const personalReset = instant(weekly?.resetsAt);
    const now = deps.now();
    if (!obj(lane) || lane.window !== 'weekly' || lane.source !== 'codex-personal-sessions' || observation?.source !== 'codex-personal-sessions' ||
        !obj(personal) || personal.state !== 'current' || personalResult.code !== 0 || !weekly || weekly.kind !== 'weekly' ||
        !percent(lane.usedPct) || !percent(weekly.usedPct) || ledgerAt === null || personalAt === null || ledgerAt !== personalAt ||
        !Number.isFinite(now) || personalAt > now || now - personalAt > CODEX_USAGE_STALE_MS || ledgerReset === null || personalReset === null) {
      emit({ v: 1, result: 'incomparable' });
      return 3;
    }
    const match = lane.usedPct === weekly.usedPct && ledgerReset === personalReset;
    emit({ v: 1, result: match ? 'match' : 'mismatch', observedAt: new Date(personalAt).toISOString(),
      ledger: { usedPct: lane.usedPct, resetAt: new Date(ledgerReset).toISOString() },
      personal: { usedPct: weekly.usedPct, resetAt: new Date(personalReset).toISOString() } });
    return match ? 0 : 1;
  } catch {
    emit({ v: 1, error: 'read_failed' });
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
