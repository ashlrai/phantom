#!/usr/bin/env node
// Merge rate and launch-to-merge latency from the local fleet metrics ledger,
// split into auto-authored filler and real work by job id. Read-only.
//
// Usage:
//   node scripts/fleet-real-merges.mjs [--hours N] [--jobs PATH] [--json]
//
//   --hours N   merge-observation window in hours, 1..168 (default 24)
//   --jobs PATH metrics ledger file (default $ASHLR_RUNS_DIR/metrics/jobs.jsonl,
//               else ~/.ashlr-runs/metrics/jobs.jsonl)
//   --json      print the fleet.real-merges.v1 report instead of a text table
//
// Rows: { job, event, ts, ... } — one JSON object per line. A job counts once
// at its earliest observed `outcome` row with state MERGED inside
// [now - hours, now]; its earliest `launch` row supplies the launch-to-merge
// duration even when it predates the window. Malformed lines are skipped and
// counted. A missing ledger reports empty totals.
// Exit codes: 0 success, 1 unreadable ledger, 2 invalid arguments.

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOUR_MS = 3_600_000;
const LEDGER_LIMIT = 32 * 1024 * 1024;
const FILLER = /A\d{6,}Q8$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const USAGE = `Usage: node scripts/fleet-real-merges.mjs [--hours N] [--jobs PATH] [--json]
--hours N   merge-observation window in hours, 1..168 (default 24)
--jobs PATH metrics ledger file (default $ASHLR_RUNS_DIR/metrics/jobs.jsonl, else ~/.ashlr-runs/metrics/jobs.jsonl)
--json      print the fleet.real-merges.v1 report instead of a text table`;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && IDENTIFIER.test(value);
const jobId = row => row.job ?? row.job_id ?? row.id;

/** Auto-authored filler jobs end in A + 6 or more digits + Q8; all else is real work. */
export function classifyMergeJob(id) {
  return FILLER.test(id) ? 'author' : 'real';
}

const median = values => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value * 10) / 10;
};

export function realMergeReport(input, hours = 24, now = Date.now()) {
  if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(now)) throw new Error('Invalid reporting window');
  const launched = new Map();
  const merged = new Map();
  let malformed = 0;
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { malformed++; continue; }
    if (!object(row) || !identifier(jobId(row)) || typeof row.ts !== 'string' || !Number.isFinite(Date.parse(row.ts)) || typeof row.event !== 'string') {
      malformed++; continue;
    }
    const id = String(jobId(row));
    const at = Date.parse(row.ts);
    if (row.event === 'launch') {
      if (at <= now && (!launched.has(id) || at < launched.get(id))) launched.set(id, at);
    } else if (row.event === 'outcome' && String(row.state).toUpperCase() === 'MERGED' && (!merged.has(id) || at < merged.get(id))) {
      merged.set(id, at);
    }
  }
  const floor = now - hours * HOUR_MS;
  const classes = ['author', 'real', 'total'];
  const merges = { author: 0, real: 0, total: 0 };
  const durations = { author: [], real: [], total: [] };
  for (const [id, mergeAt] of merged) {
    if (mergeAt > now || mergeAt < floor) continue;
    const cls = classifyMergeJob(id);
    merges[cls] += 1;
    merges.total += 1;
    const launchAt = launched.get(id);
    if (launchAt === undefined || mergeAt < launchAt) continue;
    durations[cls].push((mergeAt - launchAt) / 60000);
    durations.total.push((mergeAt - launchAt) / 60000);
  }
  const summarize = cls => ({
    class: cls,
    merges: merges[cls],
    mergesPerHour: Math.round(merges[cls] / hours * 1000) / 1000,
    medianLaunchToMergeMinutes: median(durations[cls]),
  });
  return { schema: 'fleet.real-merges.v1', hours, generatedAt: new Date(now).toISOString(), malformed, rows: classes.map(summarize) };
}

/** Descriptor-bound read, capped at LEDGER_LIMIT; symlinks are refused. */
async function readLedger(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > LEDGER_LIMIT) throw new Error('Unavailable metrics');
    const buffer = Buffer.alloc(LEDGER_LIMIT + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > LEDGER_LIMIT) throw new Error('Unavailable metrics');
    return buffer.subarray(0, offset).toString('utf8');
  } finally { await file.close(); }
}

function parseArgs(argv) {
  const parsed = { help: false, json: false, hours: 24, jobs: null };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      if (seen.has('--help')) return null;
      seen.add('--help');
      parsed.help = true;
    } else if (arg === '--json') {
      if (seen.has(arg)) return null;
      seen.add(arg);
      parsed.json = true;
    } else if (arg === '--hours' || arg === '--jobs') {
      if (seen.has(arg)) return null;
      seen.add(arg);
      const value = argv[++i];
      if (!value || value.startsWith('-') || value.includes('\0')) return null;
      if (arg === '--hours') {
        if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
        parsed.hours = Number(value);
        if (!Number.isFinite(parsed.hours) || parsed.hours < 1 || parsed.hours > 168) return null;
      } else parsed.jobs = value;
    } else return null;
  }
  return parsed;
}

function formatText(report) {
  const medianCell = value => value === null ? '-' : value.toFixed(1);
  return [
    'class merges per_hour median_min',
    ...report.rows.map(row => `${row.class} ${row.merges} ${row.mergesPerHour.toFixed(3)} ${medianCell(row.medianLaunchToMergeMinutes)}`),
    `Malformed rows: ${report.malformed}`,
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (!parsed) {
    console.error(`error: invalid arguments\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  const jobsPath = parsed.jobs ?? join(process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'metrics', 'jobs.jsonl');
  let text;
  try {
    text = await readLedger(jobsPath);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(String(error?.code))) text = '';
    else {
      console.error('fleet real-merges: metrics unavailable');
      return 1;
    }
  }
  let report;
  try {
    report = realMergeReport(text, parsed.hours, Date.now());
  } catch {
    console.error('fleet real-merges: metrics unavailable');
    return 1;
  }
  console.log(parsed.json ? JSON.stringify(report) : formatText(report));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
