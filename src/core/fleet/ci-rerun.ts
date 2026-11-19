import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readSync, readFileSync, fstatSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { CloudGh } from '../cloud/pr-actions.js';
import { ashlrHome } from '../cloud/store.js';
import { displaySurfaceTarget, evaluateStandingAuthority } from '../authority/effective-config.js';
import { readKillSwitch } from '../sandbox/policy.js';
import { analyzeCiBaseline, enqueueBaselineFixes } from './ci-baseline.js';
import { enqueueFlakeFixes, JOURNAL_TEST_MAX, recurringFlakes } from './ci-flakes.js';
import { defaultCiGh } from './ci-failure-groups.js';

type Entry = { at: string; repo: string; head: string; runId: number; pr: number; outcome: 'attempt' | 'ok' | 'failed'; test?: string };
type RepoStatus = { groups: number; attempted: number; ok: number; failed: number; skippedDuplicate: number; skippedCap: number; queued: number; flakeFixesQueued: number; recurringFlakes: number; queueBlocked: string | null; errors: string[] };
export interface CiRerunOptions {
  repos: string[];
  signal: AbortSignal;
  maxPerHour?: number;
  gh?: CloudGh;
  analyzer?: typeof analyzeCiBaseline;
  now?: () => number;
  queueFile?: string;
  journalPath?: string;
  statusPath?: string;
  autonomyEffective?: () => boolean;
  killOff?: () => boolean;
}

export function ciRerunPaths() {
  const root = join(ashlrHome(), 'ci-reruns');
  return { journalPath: join(root, 'journal.jsonl'), statusPath: join(root, 'status.json') };
}

export function readCiReruns(path = ciRerunPaths().journalPath, now = Date.now()) {
  const entries: Entry[] = [];
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size, start = Math.max(0, size - 4 * 1024 * 1024);
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n');
      if (start) lines.shift();
      for (const line of lines) {
        try {
          const e = JSON.parse(line) as Entry;
          if (typeof e.repo === 'string' && typeof e.head === 'string' && Number.isSafeInteger(e.runId) && Number.isFinite(Date.parse(e.at)) && ['attempt', 'ok', 'failed'].includes(e.outcome)) entries.push(e);
        } catch { /* malformed journal row */ }
      }
    } finally { closeSync(fd); }
  } catch { /* absent journal */ }
  const attempts = entries.filter(e => e.outcome === 'attempt');
  return { entries, recent: entries.slice(-100), counts: { attempted: attempts.length, ok: entries.filter(e => e.outcome === 'ok').length, failed: entries.filter(e => e.outcome === 'failed').length }, lastHour: attempts.filter(e => Date.parse(e.at) > now - 3_600_000).length, recurringFlakes: recurringFlakes(entries, { nowMs: now }) };
}

export function readCiRerunStatus(path = ciRerunPaths().statusPath): { lastRunAt: string; status: string; repos: Record<string, RepoStatus> } | null {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export async function runCiRerunMaintenance(opts: CiRerunOptions) {
  const paths = { ...ciRerunPaths(), ...opts }, now = opts.now ?? Date.now;
  const status = { lastRunAt: new Date(now()).toISOString(), status: 'ok', repos: {} as Record<string, RepoStatus> };
  const journal = readCiReruns(paths.journalPath, now()).entries;
  const append = (entry: Entry) => {
    mkdirSync(dirname(paths.journalPath), { recursive: true });
    appendFileSync(paths.journalPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
    const fd = openSync(paths.journalPath, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    journal.push(entry);
  };
  const gh: CloudGh = async args => {
    opts.signal.throwIfAborted();
    let abort: () => void = () => undefined;
    try {
      return await Promise.race([
        (opts.gh ?? defaultCiGh)(args),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(opts.signal.reason ?? new Error('aborted'));
          opts.signal.addEventListener('abort', abort, { once: true });
          if (opts.signal.aborted) abort();
        }),
      ]);
    } finally { opts.signal.removeEventListener('abort', abort); }
  };
  try {
    for (const repo of opts.repos) {
      opts.signal.throwIfAborted();
      const s: RepoStatus = { groups: 0, attempted: 0, ok: 0, failed: 0, skippedDuplicate: 0, skippedCap: 0, queued: 0, flakeFixesQueued: 0, recurringFlakes: 0, queueBlocked: null, errors: [] };
      status.repos[repo] = s;
      try {
        const report = await (opts.analyzer ?? analyzeCiBaseline)(repo, gh);
        opts.signal.throwIfAborted();
        s.groups = report.groups.length;
        s.errors.push(...report.errors);
        for (const group of report.groups) {
          opts.signal.throwIfAborted();
          if (group.classification !== 'probable-flake' || group.action !== 'rerun-failed') continue;
          for (const run of group.runs) {
            opts.signal.throwIfAborted();
            if (journal.some(e => e.repo === repo && e.head === run.head && e.runId === run.runId)) { s.skippedDuplicate++; continue; }
            const cap = opts.maxPerHour ?? 10;
            if (!Number.isFinite(cap) || journal.filter(e => e.outcome === 'attempt' && Date.parse(e.at) > now() - 3_600_000).length >= Math.max(0, cap)) { s.skippedCap++; continue; }
            const entry: Entry = { at: new Date(now()).toISOString(), repo, ...run, outcome: 'attempt' };
            if (typeof group.testId === 'string' && group.testId) entry.test = group.testId.slice(0, JOURNAL_TEST_MAX);
            append(entry);
            s.attempted++;
            let ok = false;
            try { ok = (await gh(['run', 'rerun', String(run.runId), '--failed', '--repo', repo])).ok; }
            catch (error) { if (opts.signal.aborted) throw error; }
            append({ ...entry, at: new Date(now()).toISOString(), outcome: ok ? 'ok' : 'failed' });
            if (ok) s.ok++; else s.failed++;
          }
        }
        opts.signal.throwIfAborted();
        const flakes = recurringFlakes(journal.filter(e => e.repo === repo), { nowMs: now() });
        s.recurringFlakes = flakes.length;
        const sharedBaseline = report.groups.some(g => g.classification === 'shared-baseline');
        if (sharedBaseline || flakes.length > 0) {
          const queuePath = opts.queueFile ?? join(homedir(), '.ashlr-runs/queue/router-queue.md');
          const authority = (opts.autonomyEffective ?? (() => evaluateStandingAuthority({ mode: 'cached', surface: displaySurfaceTarget() }).effectiveSwitch !== 'off'))();
          const killOff = (opts.killOff ?? (() => readKillSwitch().state === 'inactive'))();
          if (!authority || !killOff) s.queueBlocked = [!authority ? 'autonomy-off' : '', !killOff ? 'kill-on-or-unknown' : ''].filter(Boolean).join(',');
          else {
            if (sharedBaseline) s.queued = enqueueBaselineFixes(report, queuePath).length;
            s.flakeFixesQueued = enqueueFlakeFixes(flakes, queuePath).length;
          }
        }
      } catch (error) {
        if (opts.signal.aborted) throw error;
        s.errors.push(error instanceof Error ? error.message : 'maintenance failed');
      }
    }
  } catch (error) {
    if (!opts.signal.aborted) throw error;
  } finally {
    if (opts.signal.aborted) status.status = 'aborted';
    mkdirSync(dirname(paths.statusPath), { recursive: true });
    writeFileSync(paths.statusPath + '.tmp', JSON.stringify(status), { mode: 0o600 });
    renameSync(paths.statusPath + '.tmp', paths.statusPath);
  }
  return status;
}
