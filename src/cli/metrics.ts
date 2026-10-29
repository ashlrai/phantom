/** `phm metrics [summary|dashboard|record|recommend|ingest]` — local telemetry + value metrics. */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { rejectUnknownOptions } from './args.js';
import { ashlrHome } from '../core/cloud/store.js';
import { readTelemetry, recordEvent, type TelemetryInput } from '../core/metrics/telemetry.js';
import { recommend, rollup } from '../core/metrics/scoring.js';
import { renderDashboard } from '../core/metrics/dashboard.js';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../core/verse/preferences.js';
import { defaultStewardPolicy, runSteward } from '../core/steward/disk.js';
import { ingestMetrics, MetricsInputError } from '../core/fleet/metrics-ingest.js';
import { computeIdleAllowance, type IdleJob, type IdleSnapshot } from '../core/metrics/idle-allowance.js';

const USAGE = `Usage: phm metrics <summary|dashboard [--out file]|record <json>|recommend <taskType> <arm...>|ingest --jobs <jobs.jsonl> --status <status.json>|idle --status <snapshot.json> [--status <snapshot.json> ...] --jobs <jobs.jsonl>> [--json]
phm metrics ingest reads two explicit local files and prints deterministic lane and tier metrics as JSON.
No network, writes, provider calls or operational routing changes. See docs/METRICS-ROUTER-FEED.md for schemas.
Exit 0: report or help. Exit 2: invalid arguments or refused input.`;

interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

function cmdIdle(args: string[], json: boolean, io: CliIo): number {
  const statuses: string[] = [];
  let jobsPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    const value = args[++i];
    if (!value || value.startsWith('-')) { io.err(USAGE); return 2; }
    if (option === '--status') statuses.push(value);
    else if (option === '--jobs' && jobsPath === undefined) jobsPath = value;
    else { io.err(USAGE); return 2; }
  }
  if (!statuses.length || !jobsPath) { io.err(USAGE); return 2; }
  try {
    const snapshots: IdleSnapshot[] = statuses.flatMap(path => {
      const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return (Array.isArray(data) ? data : [data]) as IdleSnapshot[];
    });
    const jobs = readFileSync(jobsPath, 'utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as IdleJob);
    const report = computeIdleAllowance(snapshots, jobs);
    if (json) io.out(JSON.stringify(report, null, 2));
    else {
      io.out(`Idle slot-minutes (${report.from} to ${report.to})`);
      for (const lane of report.lanes) io.out(`${lane.lane}: ${lane.idleSlotMinutes} idle, ${lane.pausedSlotMinutes} paused; reasons: ${JSON.stringify(lane.pausedReasons)}`);
      for (const job of report.stuckJobs) io.out(`Stuck ${job.id} (${job.lane}): ${job.elapsedMinutes} minutes; median ${job.medianWallMinutes}`);
    }
    return 0;
  } catch { io.err('Unable to read or parse idle metrics input.'); return 1; }
}

function cmdIngest(args: string[], io: CliIo): number {
  const usage = (): number => { io.err(USAGE); return 2; };
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (!['--jobs', '--status'].includes(option) || options.has(option)) return usage();
    const value = args[++i];
    if (!value || value.startsWith('-')) return usage();
    options.set(option, value);
  }
  const jobs = options.get('--jobs'), status = options.get('--status');
  if (!jobs || !status) return usage();
  try {
    io.out(JSON.stringify(ingestMetrics(jobs, status), null, 2));
    return 0;
  } catch (error) {
    io.err(error instanceof MetricsInputError ? error.message : 'Metrics input could not be read.');
    return 2;
  }
}

export function cmdMetrics(argv: string[], io: CliIo = { out: console.log, err: console.error }): number {
  if (argv.includes('--help') || argv.includes('-h')) { io.out(USAGE); return 0; }
  const json = argv.includes('--json');
  const [sub = 'summary', ...rest] = argv.filter((a) => a !== '--json');
  if (sub === 'help') { io.out(USAGE); return 0; }
  if (sub === 'ingest') return cmdIngest(rest, io);
  if (sub === 'idle') return cmdIdle(rest, json, io);
  if (rejectUnknownOptions(rest, sub === 'dashboard' ? { values: ['--out'] } : {})) { io.err(USAGE); return 2; }
  try {
    switch (sub) {
      case 'summary': {
        if (rest.length) { io.err(USAGE); return 2; }
        const r = rollup(readTelemetry());
        if (json) io.out(JSON.stringify(r, null, 2));
        else io.out(`${r.totals.prsShipped} PRs shipped · ${r.totals.valuePerMTok} value/1M tok · ${r.totals.valuePerHour} value/hr · ${r.totals.valuePerUsd ?? '—'} value/$`);
        return 0;
      }
      case 'dashboard': {
        if (rest.length && (rest.length !== 2 || rest[0] !== '--out' || !rest[1] || rest[1].startsWith('-'))) { io.err(USAGE); return 2; }
        const out = rest[1] ?? join(ashlrHome(), 'metrics', 'dashboard.html');
        const html = renderDashboard(rollup(readTelemetry()), runSteward(defaultStewardPolicy()));
        if (!rest.length) { ensurePrivateDirectory(ashlrHome()); ensurePrivateDirectory(join(ashlrHome(), 'metrics')); }
        writePrivateFileAtomic(out, html);
        io.out(out); return 0;
      }
      case 'record': { if (rest.length !== 1) { io.err(USAGE); return 2; } let input: TelemetryInput; try { input = JSON.parse(rest[0]!) as TelemetryInput; } catch { io.err('phm metrics: invalid JSON event.'); return 2; } const ev = recordEvent(input); io.out(json ? JSON.stringify(ev) : ev.id); return 0; }
      case 'recommend': { const [taskType, ...arms] = rest; if (!taskType || !arms.length) { io.err(USAGE); return 2; } io.out(JSON.stringify(recommend(readTelemetry(), taskType, arms), null, 2)); return 0; }
      default: io.err(USAGE); return 2;
    }
  } catch { io.err('phm metrics: unable to process metrics; check the event schema and local file permissions.'); return 1; }
}
