/**
 * disk-maint: the protect-list holds under every flag, and each reclaim
 * class attributes and frees the bytes it claims. Uses real temp trees like
 * the steward tests; git worktree removal goes through an injected runner.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planDiskMaint, type MaintDeps, type MaintRoots } from '../src/core/disk-maint/plan.js';
import { applyDiskMaint } from '../src/core/disk-maint/apply.js';
import { protectedReason, protectedRoots, resolveMaintRoots } from '../src/core/disk-maint/protect.js';
import { diskMaintSchedule } from '../src/core/disk-maint/schedule.js';
import { readWorktreePulls } from '../src/core/disk-maint/worktree-evidence.js';
import { cmdDiskMaint, formatDiskMaint } from '../src/cli/disk-maint.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const DAY = 86_400_000;

let home: string;
let roots: MaintRoots;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'phm-disk-maint-'));
  roots = resolveMaintRoots({ home });
  mkdirSync(roots.ashlrDir, { recursive: true });
  mkdirSync(roots.runsDir, { recursive: true });
  mkdirSync(roots.wtDir, { recursive: true });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const file = (rel: string, bytes: number, ageDays: number): string => {
  const p = join(home, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, Buffer.alloc(bytes, 7));
  const t = (NOW - ageDays * DAY) / 1000;
  utimesSync(p, t, t);
  return p;
};
const dir = (rel: string, ageDays: number): string => {
  const p = join(home, rel);
  mkdirSync(p, { recursive: true });
  const t = (NOW - ageDays * DAY) / 1000;
  utimesSync(p, t, t);
  return p;
};
/** Re-stamp a dir after writes inside it changed its mtime. */
const age = (path: string, ageDays: number): void => {
  const t = (NOW - ageDays * DAY) / 1000;
  utimesSync(path, t, t);
};

const jobsText = (rows: Record<string, unknown>[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const HEALTHY = (text: string): NonNullable<MaintDeps['readJobs']> => async () => ({ state: 'healthy', text });

const baseDeps = (extra: MaintDeps = {}): MaintDeps => ({
  now: NOW,
  roots,
  readJobs: HEALTHY(''),
  readWorktreeProcesses: async () => ({ argv: '', cwd: '' }),
  lookupWorktreePulls: async () => null,
  readWorktreeBridgeCommits: async () => new Map(),
  worktreeHasUnpushed: async () => false,
  kept: () => false,
  freeBytes: () => 200e9,
  measure: (_d: string) => ({ bytes: 1000, complete: true }),
  ...extra,
});

const classPlan = async (id: string, deps: MaintDeps = {}) => {
  const plan = await planDiskMaint(baseDeps(deps));
  return { plan, cls: plan.classes.find(c => c.id === id)! };
};

describe('protect-list', () => {
  it('refuses CMP codex homes, model weights, docker, client trees and secrets', () => {
    const cases: [string, RegExp][] = [
      [join(home, '.codex/sessions/a.jsonl'), /protected/],
      [join(home, '.codex-2/sessions/a.jsonl'), /protected/],
      [join(home, '.cache/huggingface/hub/m.bin'), /protected/],
      [join(home, 'Desktop/github/side-projects/hle-solver/models/m.gguf'), /protected/],
      [join(home, 'Desktop/github/side-projects/dhs-biothreat/.venv'), /protected/],
      [join(home, 'Desktop/github/side-projects/Client-Work/x'), /protected/],
      [join(home, 'Desktop/github/side-projects/rde-other/x'), /protected/],
      [join(home, '.docker/contexts/x'), /protected/],
      [join(home, 'Library/Containers/com.docker.docker/x'), /protected/],
      [join(home, 'Documents/client/f.txt'), /protected/],
      [join(home, '.ashlr/wt/JOB-1/.git/refs/heads/main'), /protected/],
      [join(home, '.ashlr/native-profiles/codex-a/native-state/auth.json'), /protected/],
      [join(home, '.ashlr/native-profiles/codex-a/native-state/config.toml'), /protected/],
      [join(home, '.ashlr-runs/quarantine/RQ-1-x/out.txt'), /protected/],
      [join(home, '.ashlr-runs/bin/dispatchd.py'), /protected/],
      [join(home, '.ashlr-runs/metrics/jobs.jsonl'), /protected/],
      [join(home, '.ashlr/secrets/typesafe.env'), /protected/],
      [join(home, '.ssh/id_ed25519'), /protected/],
      ['relative/path/file.log', /not-absolute/],
    ];
    for (const [path, re] of cases) {
      expect(protectedReason(path, roots) ?? 'null', path).toMatch(re);
    }
  });

  it('protects every real ~/.codex* directory, not only the literal name', () => {
    dir('.codex-cmp/sessions', 1);
    expect(protectedRoots(roots).some(r => r.endsWith('.codex-cmp'))).toBe(true);
    expect(protectedReason(join(home, '.codex-cmp/sessions/a.jsonl'), roots)).toMatch(/protected/);
  });

  it('allows the paths maintenance owns', () => {
    const ok = [
      join(home, '.ashlr-runs/RQ-1.log'),
      join(home, '.ashlr/logs/phm.log'),
      join(home, '.ashlr/native-profiles/codex-a/native-state/sessions/a.jsonl'),
      join(home, '.ashlr/updates/staged/pkg-1'),
      join(home, 'Desktop/github/side-projects/hle-solver/.venv'),
      join(home, 'Projects/ashlrai/wt/RQ-1'),
    ];
    for (const path of ok) expect(protectedReason(path, roots), path).toBeNull();
  });
});

describe('run-logs class', () => {
  const ledger = jobsText([
    { job: 'RQ-DONE-1', event: 'outcome', state: 'MERGED', ts: '2026-10-20T00:00:00Z' },
    { job: 'RQ-OPEN-1', event: 'outcome', state: 'OPEN', ts: '2026-10-20T00:00:00Z' },
  ]);

  it('compresses terminal job logs by age and deletes the oldest', async () => {
    file('.ashlr-runs/RQ-DONE-1.log', 2048, 10);
    file('.ashlr-runs/RQ-DONE-1.launch', 512, 60);
    file('.ashlr-runs/RQ-OPEN-1.log', 2048, 10);      // open job: orphan ages only
    file('.ashlr-runs/RQ-OPEN-1.log.keep', 512, 60);  // not a log suffix: never a candidate
    const { cls } = await classPlan('run-logs', { readJobs: HEALTHY(ledger) });
    const byPath = new Map(cls.candidates.map(c => [c.path, c]));
    expect(byPath.get(join(home, '.ashlr-runs/RQ-DONE-1.log'))?.action).toBe('compress-file');
    expect(byPath.get(join(home, '.ashlr-runs/RQ-DONE-1.launch'))?.action).toBe('delete-file');
    expect(byPath.has(join(home, '.ashlr-runs/RQ-OPEN-1.log'))).toBe(false); // 10d < 30d orphan compress
    expect(byPath.has(join(home, '.ashlr-runs/RQ-OPEN-1.log.keep'))).toBe(false);
  });

  it('rotates oversized live logs and prunes ancient rotated output', async () => {
    file('.ashlr-runs/disk.log', 2048, 1);
    file('.ashlr-runs/disk.log.1', 512, 60);
    file('.ashlr-runs/queue/dispatch-events.log', 2048, 1);
    const { cls } = await classPlan('run-logs', { readJobs: HEALTHY(ledger), policy: { rotateBytes: 1000 } });
    const byPath = new Map(cls.candidates.map(c => [c.path, c]));
    expect(byPath.get(join(home, '.ashlr-runs/disk.log'))?.action).toBe('rotate-compress');
    expect(byPath.get(join(home, '.ashlr-runs/disk.log.1'))?.action).toBe('delete-file');
    expect(byPath.get(join(home, '.ashlr-runs/queue/dispatch-events.log'))?.action).toBe('rotate-compress');
  });

  it('never touches queue state files or .base/.publish markers', async () => {
    file('.ashlr-runs/queue/ready.tsv', 512, 300);
    file('.ashlr-runs/queue/precheck-skips.tsv', 512, 300);
    file('.ashlr-runs/queue/notes.txt', 512, 300);
    file('.ashlr-runs/RQ-1.base', 128, 300);
    file('.ashlr-runs/.publish', 128, 300);
    const { cls } = await classPlan('run-logs', { readJobs: HEALTHY('') });
    expect(cls.candidates).toHaveLength(0);
  });

  it('keeps everything when the ledger is unreadable: states stay conservative', async () => {
    file('.ashlr-runs/RQ-DONE-1.log', 2048, 10);
    const { plan, cls } = await classPlan('run-logs', { readJobs: async () => ({ state: 'degraded', text: '' }) });
    expect(plan.jobsSource).toBe('degraded');
    expect(cls.candidates).toHaveLength(0); // 10d < 30d orphan compress age
  });
});

describe('agent-sessions class', () => {
  it('compresses then deletes aged session files under native-state subdirs', async () => {
    file('.ashlr/native-profiles/codex-a/native-state/sessions/2026/09/rollout-a.jsonl', 4096, 20);
    file('.ashlr/native-profiles/codex-a/native-state/sessions/2026/08/rollout-b.jsonl', 4096, 70);
    file('.ashlr/native-profiles/grok-a/native-state/logs/g.log', 512, 3);
    file('.ashlr/native-profiles/codex-a/native-state/auth.json', 128, 200);
    file('.ashlr/native-profiles/codex-a/native-state/config.toml', 128, 200);
    const { plan, cls } = await classPlan('agent-sessions');
    const byPath = new Map(cls.candidates.map(c => [c.path, c]));
    expect(byPath.get(join(home, '.ashlr/native-profiles/codex-a/native-state/sessions/2026/09/rollout-a.jsonl'))?.action).toBe('compress-file');
    expect(byPath.get(join(home, '.ashlr/native-profiles/codex-a/native-state/sessions/2026/08/rollout-b.jsonl'))?.action).toBe('delete-file');
    expect(byPath.has(join(home, '.ashlr/native-profiles/grok-a/native-state/logs/g.log'))).toBe(false);
    expect([...byPath.keys()].filter(p => /auth\.json|config\.toml/.test(p))).toHaveLength(0);
    expect(plan.refused.some(r => /auth\.json|config\.toml/.test(r.path))).toBe(true);
  });

  it('never descends into protected subtrees inside session dirs', async () => {
    file('.ashlr/native-profiles/codex-a/native-state/sessions/models/big.gguf', 4096, 70);
    file('.ashlr/native-profiles/codex-a/native-state/sessions/.git/objects/pack/x', 128, 70);
    const { cls } = await classPlan('agent-sessions');
    expect(cls.candidates.filter(c => /models|\.git/.test(c.path))).toHaveLength(0);
  });
});

describe('ashlr-logs class', () => {
  it('skips symlinks and .keep markers inside scanned roots', async () => {
    const real = file('.ashlr/agent-logs/real.jsonl', 2048, 60);
    symlinkSync(real, join(home, '.ashlr/agent-logs/linked.jsonl'));
    file('.ashlr/agent-logs/holder.keep', 512, 60);
    file('.ashlr/agent-logs/queue.log.keep', 512, 60);
    const { cls } = await classPlan('ashlr-logs');
    const names = cls.candidates.map(c => c.path);
    expect(names.some(p => p.endsWith('linked.jsonl'))).toBe(false);
    expect(names.some(p => /\.keep$/.test(p))).toBe(false);
    expect(names).toContain(real);
  });

  it('covers log roots and root-level log files, skipping live ones', async () => {
    file('.ashlr/agent-logs/run1.jsonl', 2048, 20);
    file('.ashlr/crashes/crash.log', 512, 60);
    file('.ashlr/run-streams/s1.jsonl', 512, 20);
    file('.ashlr/ashlr.log.3', 1024, 40);
    file('.ashlr/ashlr.log', 1024, 1);
    file('.ashlr/config.json', 128, 40); // not a log name
    const { cls } = await classPlan('ashlr-logs');
    const byPath = new Map(cls.candidates.map(c => [c.path, c]));
    expect(byPath.get(join(home, '.ashlr/agent-logs/run1.jsonl'))?.action).toBe('compress-file');
    expect(byPath.get(join(home, '.ashlr/crashes/crash.log'))?.action).toBe('delete-file');
    expect(byPath.get(join(home, '.ashlr/run-streams/s1.jsonl'))?.action).toBe('compress-file');
    expect(byPath.get(join(home, '.ashlr/ashlr.log.3'))?.action).toBe('compress-file');
    expect(byPath.has(join(home, '.ashlr/ashlr.log'))).toBe(false);
    expect(byPath.has(join(home, '.ashlr/config.json'))).toBe(false);
  });
});

describe('recovery-dirs class', () => {
  it('removes stale recovery copies and .bak files, keeps fresh ones', async () => {
    dir('.ashlr/native-profiles/claude-a-recovery-20261011', 40);
    dir('.ashlr/native-profiles/codex-b-recovery-20261101', 2);
    dir('.ashlr/cortex-backup-drill-54vEzm', 40);
    file('.ashlr/config.json.bak-1700000000', 128, 40);
    file('.ashlr/backlog.json', 128, 40); // live file: not a .bak
    const { cls } = await classPlan('recovery-dirs');
    const names = cls.candidates.map(c => c.path);
    expect(names.some(p => /claude-a-recovery/.test(p))).toBe(true);
    expect(names.some(p => /codex-b-recovery/.test(p))).toBe(false);
    expect(names.some(p => /cortex-backup-drill/.test(p))).toBe(true);
    expect(names.some(p => /config\.json\.bak/.test(p))).toBe(true);
    expect(names.some(p => /backlog\.json$/.test(p))).toBe(false);
  });
});

describe('staging class', () => {
  it('reaps update staging children, cloud checkouts and temp worktrees by age', async () => {
    dir('.ashlr/updates/staged/pkg-1', 10);
    dir('.ashlr/updates/consumer-staging/first-abc', 10);
    dir('.ashlr/updates/staged/pkg-2', 2);
    dir('.ashlr/cloud/checkouts/ashlrai__ashlr-hub', 10);
    dir('.ashlr/tmp/vwt-aa11bb', 10);
    dir('.ashlr/tmp/scratch-notes', 10); // not a temp-worktree name
    const { cls } = await classPlan('staging');
    const names = cls.candidates.map(c => c.path);
    expect(names.some(p => /pkg-1$/.test(p))).toBe(true);
    expect(names.some(p => /first-abc$/.test(p))).toBe(true);
    expect(names.some(p => /pkg-2$/.test(p))).toBe(false);
    expect(names.some(p => /ashlrai__ashlr-hub$/.test(p))).toBe(true);
    expect(names.some(p => /vwt-aa11bb$/.test(p))).toBe(true);
    expect(names.some(p => /scratch-notes$/.test(p))).toBe(false);
  });
});

describe('caches class', () => {
  it('reaps summary-cache entries and genome index caches by age', async () => {
    file('.ashlr/summary-cache/e1.json', 512, 20);
    file('.ashlr/summary-cache/e2.json', 512, 3);
    file('.ashlr/genome-index-00fe7410ad96.cache', 2048, 20);
    const { cls } = await classPlan('caches');
    const names = cls.candidates.map(c => c.path);
    expect(names.some(p => /e1\.json$/.test(p))).toBe(true);
    expect(names.some(p => /e2\.json$/.test(p))).toBe(false);
    expect(names.some(p => /genome-index-00fe/.test(p))).toBe(true);
  });
});

describe('worktree classes', () => {
  const ledger = jobsText([
    { job: 'RQ-OLD-MERGED', event: 'finish', ts: '2026-10-01T00:00:00Z' },
    { job: 'RQ-OLD-MERGED', event: 'outcome', state: 'MERGED', ts: '2026-10-01T00:05:00Z' },
    { job: 'RQ-OPEN', event: 'outcome', state: 'OPEN', ts: '2026-10-01T00:00:00Z' },
    { job: 'RQ-FRESH', event: 'finish', ts: '2026-11-01T11:30:00Z' },
    { job: 'RQ-FRESH', event: 'outcome', state: 'MERGED', ts: '2026-11-01T11:31:00Z' },
    { job: 'RQ-EMPTY', event: 'finish', ts: '2026-10-01T00:00:00Z', empty: true },
  ]);

  it('runs-dir worktrees reap merged and empty; jobs-dir reaps merged only', async () => {
    dir('.ashlr-runs/wt/RQ-OLD-MERGED', 5);
    dir('.ashlr-runs/wt/RQ-OPEN', 5);
    dir('.ashlr-runs/wt/RQ-EMPTY', 5);
    dir('Projects/ashlrai/wt/RQ-OLD-MERGED', 5);
    dir('Projects/ashlrai/wt/RQ-FRESH', 0);
    dir('Projects/ashlrai/wt/guardian-phantom', 60);
    const { cls: runs } = await classPlan('worktrees-runs', { readJobs: HEALTHY(ledger) });
    const { cls: jobs } = await classPlan('worktrees-jobs', { readJobs: HEALTHY(ledger) });
    const runsNames = runs.candidates.map(c => c.path);
    expect(runsNames.some(p => /RQ-OLD-MERGED$/.test(p))).toBe(true);
    expect(runsNames.some(p => /RQ-OPEN$/.test(p))).toBe(false);
    expect(runsNames.some(p => /RQ-EMPTY$/.test(p))).toBe(true);
    const jobNames = jobs.candidates.map(c => c.path);
    expect(jobNames.some(p => /RQ-OLD-MERGED$/.test(p))).toBe(true);
    expect(jobNames.some(p => /RQ-FRESH$/.test(p))).toBe(false);
    expect(jobNames.some(p => /guardian/.test(p))).toBe(false);
  });

  it('keeps pinned worktrees', async () => {
    const pinned = dir('Projects/ashlrai/wt/RQ-OLD-MERGED', 5);
    const { cls } = await classPlan('worktrees-jobs', { readJobs: HEALTHY(ledger), kept: p => p === pinned });
    expect(cls.candidates).toHaveLength(0);
  });

  it('uses live dispatcher finish and publish rows, not a guessed outcome field', async () => {
    const base = { event: 'finish', lane: 'codex', exit_code: 0, empty: false, diff_files: 3, diff_lines: 15,
      ended_ts: '2026-10-30T00:00:00Z', wall_s: 108 };
    const pub = { event: 'publish', lane: 'codex', url: null, class: 'abort_other', ts: '2026-10-30T00:05:00Z' };
    const url = 'https://github.com/ashlrai/phantom/pull/9147';
    const jobs = ['RQ-MD-1', 'RQ-MD-2', 'RQ-MD-3', 'RQ-MD-4', 'RQ-MD-5', 'RQ-MD-6'];
    for (const job of jobs) dir(`Projects/ashlrai/wt/${job}`, 5);
    const lookup = vi.fn(async () => ({ pulls: [{ url, state: 'MERGED' as const, at: NOW - 48 * 3600000 }] }));
    const { cls } = await classPlan('worktrees-jobs', {
      readJobs: HEALTHY(jobsText([
        { ...pub, job: jobs[0], url, class: 'published' },
        { ...base, job: jobs[0] },
        { ...base, job: jobs[1], empty: true }, { ...pub, job: jobs[1] },
        { ...base, job: jobs[2], exit_code: 1 }, { ...pub, job: jobs[2] },
        { ...base, job: jobs[3], exit_code: 1 }, { ...pub, job: jobs[3], class: 'abort_secret_shape' },
        { ...pub, job: jobs[4], url: url.replace('9147', '9148') },
        { ...base, job: jobs[5], exit_code: 1, ended_ts: new Date(NOW - 2 * 3600000).toISOString() },
      ])),
      lookupWorktreePulls: lookup,
      worktreeHasUnpushed: async p => p.endsWith('RQ-MD-3'),
    });
    expect(cls).toMatchObject({ scanned: 6, reapable: 2, protected: 4,
      reapReasons: { merged: 1, 'terminal-failed': 1 },
      protectReasons: { 'unpushed-commits': 1, 'supervisor-review': 1, 'pr-state-unknown': 1, 'too-new': 1 },
      prefixes: { 'RQ-MD': { scanned: 6, reapable: 2, protected: 4 } },
    });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('matches the 854-entry leader distribution without inferring outcomes from prefixes or bundles', async () => {
    const groups = [
      ['RQ-DEVINCLOUD-RQ-DVL-BUS', 65], ['RQ-DEVINCLOUD-RQ-DVL-RSI', 62], ['RQ-MD', 29], ['RQ-PS', 19],
      ['RQ-REBASE-PHANTOM', 17], ['RQ-CL-DOCS', 13], ['RQ-STACK', 13], ['FIXUP-CI-phantom-ecosyst', 12],
      ['RQ-DEVINCLOUD-RQ-DVL-FLE', 11], ['RQ-LOCUS', 10], ['RQ-RECUT-MR-CONFLICT-DRI', 10], ['RQ-DRAIN-phantom', 8],
      ['RQ-OTHER', 572], ['guardian', 11],
    ] as const;
    const names = groups.flatMap(([prefix, count]) => Array.from({ length: count }, (_, n) => `${prefix}-${1795413651 + n}-N17`));
    names.push('RQ-VAULT-PHM-1', 'RQ-DVL-FLEET-1795651732');
    for (const name of names) dir(`Projects/ashlrai/wt/${name}`, 10);
    const cloud = names.filter(name => name.startsWith('RQ-DEVINCLOUD'));
    const dispatcher = names.filter(name => name.startsWith('RQ-MD-') || name.startsWith('RQ-PS-'));
    const other = names.filter(name => name.startsWith('RQ-OTHER'));
    for (const name of cloud) {
      file(`.ashlr-runs/devin-cloud-in/${name}.bundle`, 5, 9);
      file(`.ashlr-runs/devin-cloud-in/${name}.pr.md`, 5, 9);
    }
    for (const name of dispatcher) file(`.ashlr-runs/${name}.base`, 5, 9);
    writeFileSync(file('.ashlr-runs/queue/keep.txt', 1, 9), other.slice(0, 83).join('\n'));
    writeFileSync(file('.ashlr-runs/queue/ready.tsv', 1, 9), other.slice(122, 125).map(name => `${name}\tphantom`).join('\n'));
    for (const name of other.slice(83, 116)) file(`.ashlr-runs/queue/run/${name}.dispatched`, 1, 9);
    const at = NOW - 3 * DAY;
    const ts = new Date(at).toISOString();
    const head = 'a'.repeat(40);
    const pulls = dispatcher.slice(0, 29).map((_, i) => ({ url: `https://github.com/ashlrai/phantom/pull/${i + 1}`, at,
      state: i < 20 ? 'MERGED' as const : i < 25 ? 'CLOSED' as const : 'OPEN' as const, prHead: head }));
    const ledger = dispatcher.flatMap((job, i) => [{
      event: 'finish', job, lane: 'codex', exit_code: i >= 29 ? 2 : 0, empty: false, diff_files: 3, diff_lines: 9, ended_ts: ts, wall_s: 62,
    }, { event: 'publish', job, lane: 'codex', url: pulls[i]?.url ?? null, class: i >= 44 ? 'abort_secret_shape' : 'publish_result', ts }]);
    const local = new Map([...cloud.slice(0, 120), 'RQ-VAULT-PHM-1'].map(job => [job, { at }]));
    const remote = Object.fromEntries([...cloud.slice(120, 133), 'RQ-DVL-FLEET-1795651732'].map(job => [job, { at, prHead: head }]));
    const lookup = vi.fn(async () => ({ pulls, bridges: remote }));
    const deps = baseDeps({
      readJobs: HEALTHY(jobsText(ledger)),
      readWorktreeProcesses: async () => ({ argv: '', cwd: other.slice(116, 122).map(job => `n${join(roots.wtDir, job)}`).join('\n') }),
      readWorktreeBridgeCommits: async () => local,
      lookupWorktreePulls: lookup,
      worktreeHasUnpushed: async path => dispatcher.slice(40, 44).some(name => path === join(roots.wtDir, name)),
    });
    const log: string[] = [];
    expect(await cmdDiskMaint(['--json', '--only', 'worktrees-runs,worktrees-jobs'],
      { roots, now: NOW, plan: deps, output: { log: line => log.push(line), error: line => { throw new Error(line); } } })).toBe(0);
    const report = JSON.parse(log.join(''));
    expect(report.classes[0]).toMatchObject({ scanned: 0, reapable: 0, protected: 0, prefixes: {} });
    const cls = report.classes[1];
    expect(cls).toMatchObject({
      scanned: 854, reapable: 171, protected: 683,
      reapReasons: { 'bridge-merged': 135, merged: 20, closed: 5, 'terminal-failed': 11 },
      protectReasons: { 'state-unknown': 535, 'live-process': 6, kept: 83, queued: 3, 'active-lease': 33, excluded: 11,
        'pr-open': 4, 'unpushed-commits': 4, 'supervisor-review': 4 },
      prefixes: {
        'RQ-DEVINCLOUD-RQ-DVL-BUS': { scanned: 65, reapable: 65, protected: 0 },
        'RQ-DEVINCLOUD-RQ-DVL-RSI': { scanned: 62, reapable: 62, protected: 0 },
        'RQ-DEVINCLOUD-RQ-DVL-FLE': { scanned: 11, reapable: 6, protected: 5 },
        'RQ-MD': { scanned: 29, reapable: 25, protected: 4 },
        'RQ-PS': { scanned: 19, reapable: 11, protected: 8 },
      },
    });
    expect(lookup).toHaveBeenCalledExactlyOnceWith(pulls.map(pull => pull.url), true);
    expect(Object.values(cls.prefixes).reduce<number>((sum, value) => sum + Number((value as { scanned: number }).scanned), 0)).toBe(854);
  });

  it('reuses fresh pull verdicts from disk and refuses expired ones during a lookup outage', async () => {
    const url = 'https://github.com/ashlrai/phantom/pull/9147';
    const lookup = vi.fn(async () => ({ pulls: [{ url, state: 'CLOSED' as const, at: NOW - DAY }] }));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      expect((await readWorktreePulls(roots, [url], false, lookup)).pulls).toHaveLength(1);
      expect((await readWorktreePulls(roots, [url], false, lookup)).pulls).toHaveLength(1);
      expect(lookup).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(NOW + 301_000);
      expect(await readWorktreePulls(roots, [url], false, async () => null)).toEqual({ pulls: [] });
    } finally { clock.mockRestore(); }
  });

  it('accounts for each of 846 leader-shaped worktrees once in the JSON dry run', async () => {
    const rows: Record<string, unknown>[] = [];
    const live: string[] = [];
    const groups = [
      ['RQ-DEVINCLOUD-RQ-DVL-BUS', 65], ['RQ-DEVINCLOUD-RQ-DVL-RSI', 60],
      ['RQ-MD', 29], ['RQ-PS', 19], ['RQ-REBASE-PHANTOM', 17], ['RQ-STACK', 13], ['RQ-MIXED', 643],
    ] as const;
    for (const [prefix, count] of groups) {
      for (let i = 0; i < count; i++) {
        const job = `${prefix}-${i}`;
        dir(`Projects/ashlrai/wt/${job}`, 10);
        const prUrl = `https://github.com/ashlrai/phantom/pull/${i + 1}`;
        if (prefix === 'RQ-MIXED' && i < 12) live.push(`n${roots.wtDir}/${job}/src`);
        if (prefix === 'RQ-MIXED' && (i === 0 || (i >= 12 && i < 22))) file(`.ashlr-runs/queue/run/${job}.batched`, 1, 9);
        if (prefix.startsWith('RQ-DEVINCLOUD-')) {
          rows.push({ jobId: job, event: 'publish', prUrl, ts: '2026-10-01T00:05:00Z', headSha: 'a'.repeat(40) });
        } else if (prefix !== 'RQ-MIXED' || i < 30 || i >= 40) rows.push({ jobId: job, prUrl,
          outcome: 'MERGED', mergedAt: '2026-10-01T00:05:00Z', source: 'metrics-outcomes-reconciler' });
      }
    }
    mkdirSync(join(roots.runsDir, 'wt'));
    const log: string[] = [];
    const plan = baseDeps({
      readJobs: HEALTHY(jobsText(rows)),
      readWorktreeProcesses: async () => ({ argv: '', cwd: live.join('\n') }),
      lookupWorktreePulls: async urls => ({ pulls: urls.map(url => ({ url, state: 'MERGED', at: NOW - DAY, prHead: 'a'.repeat(40) })) }),
      worktreeHasUnpushed: async (path, head) => /\/RQ-MIXED-2[2-9]$/.test(path) ||
        (path.includes('/RQ-DEVINCLOUD-') && head !== 'a'.repeat(40)),
    });
    expect(await cmdDiskMaint(['--json', '--only', 'worktrees-runs,worktrees-jobs'],
      { roots, now: NOW, plan, output: { log: line => log.push(line), error: line => { throw new Error(line); } } })).toBe(0);
    const report = JSON.parse(log.join(''));
    expect(report.apply).toBe(false);
    expect(report.classes[0]).toMatchObject({
      id: 'worktrees-runs', scanned: 0, reapable: 0, protected: 0, reapReasons: {}, protectReasons: {},
    });
    const cls = report.classes[1];
    expect(cls.candidates).toHaveLength(806);
    expect(cls).toMatchObject({
      id: 'worktrees-jobs', scanned: 846, reapable: 806, protected: 40,
      reapReasons: { merged: 806 },
      protectReasons: { 'live-process': 12, 'active-lease': 10, 'unpushed-commits': 8, 'state-unknown': 10 },
    });
    expect(Object.values(cls.reapReasons).reduce<number>((sum, count) => sum + Number(count), 0)).toBe(cls.reapable);
    expect(Object.values(cls.protectReasons).reduce<number>((sum, count) => sum + Number(count), 0)).toBe(cls.protected);
  });

  it('checks the exact cloud-publisher PR head, and keeps retried or queued jobs', async () => {
    const names = ['RQ-DEVINCLOUD-PUSHED', 'RQ-RETRY', 'RQ-QUEUED'];
    const ts = '2026-10-01T00:05:00Z';
    const headSha = 'a'.repeat(40);
    for (const name of names) dir(`Projects/ashlrai/wt/${name}`, 10);
    writeFileSync(file('.ashlr-runs/queue/ready.tsv', 1, 9), 'RQ-QUEUED\tphantom\tcodex\twork\tqueue/prompt.md\n');
    const checked: Array<[string, string | undefined]> = [];
    const { cls } = await classPlan('worktrees-jobs', {
      readJobs: HEALTHY(jobsText([
        { job: names[0], event: 'publish', url: 'https://github.com/ashlrai/phantom/pull/1', ts, headSha },
        { job: names[1], event: 'outcome', state: 'CLOSED', ts },
        { job: names[1], event: 'claim' },
        { job: names[2], event: 'outcome', state: 'CLOSED', ts },
      ])),
      lookupWorktreePulls: async urls => ({ pulls: urls.map(url => ({ url, state: 'CLOSED', at: NOW - DAY, prHead: headSha })) }),
      worktreeHasUnpushed: async (path, head) => { checked.push([path, head]); return head !== headSha; },
    });
    expect(checked).toEqual([[join(roots.wtDir, names[0]!), headSha]]);
    expect(cls.reapReasons).toEqual({ closed: 1 });
    expect(cls.protectReasons).toEqual({ 'state-unknown': 1, queued: 1 });
  });
});

describe('bridge-targets class', () => {
  it('reaps shared build targets quiet past the window', async () => {
    dir('.ashlr-runs/repos/abc123/target', 40);
    dir('.ashlr-runs/repos/def456/target', 3);
    const { cls } = await classPlan('bridge-targets');
    const names = cls.candidates.map(c => c.path);
    expect(names.some(p => /abc123\/target$/.test(p))).toBe(true);
    expect(names.some(p => /def456\/target$/.test(p))).toBe(false);
  });
});

describe('gated classes', () => {
  it('venvs are off by default and previewed, enabled by --allow venvs', async () => {
    const venv = dir('Desktop/github/side-projects/proj-a/.venv', 30);
    writeFileSync(join(venv, 'pyvenv.cfg'), 'home = /usr/bin\n');
    age(venv, 30); // the cfg write reset the dir mtime
    dir('Desktop/github/side-projects/proj-b/.venv', 30); // no pyvenv.cfg: not a venv
    const blocked = dir('Desktop/github/side-projects/dhs-biothreat/.venv', 30);
    writeFileSync(join(blocked, 'pyvenv.cfg'), 'x\n');
    age(blocked, 30);
    const off = await classPlan('venvs');
    expect(off.cls.enabled).toBe(false);
    expect(off.cls.candidates).toHaveLength(0); // preview keeps no paths
    expect(off.cls.bytes).toBeGreaterThan(0);  // ...but still shows the bytes
    const on = await classPlan('venvs', { allow: new Set(['venvs']) });
    const names = on.cls.candidates.map(c => c.path);
    expect(names).toEqual([venv]);
  });

  it('hub-claude prunes .claude session caches only when allowed', async () => {
    const hub = dir('Projects/ashlrai/hub', 1);
    file('Projects/ashlrai/hub/.claude/projects/old.jsonl', 2048, 40);
    file('Projects/ashlrai/hub/.claude/projects/new.jsonl', 2048, 5);
    file('Projects/ashlrai/hub/.claude/settings.json', 128, 40);
    const rootsWithHub = { ...roots, hubDir: hub };
    const off = await classPlan('hub-claude', { roots: rootsWithHub });
    expect(off.cls.enabled).toBe(false);
    const on = await classPlan('hub-claude', { roots: rootsWithHub, allow: new Set(['hub-claude']) });
    const names = on.cls.candidates.map(c => c.path);
    expect(names.some(p => /old\.jsonl$/.test(p))).toBe(true);
    expect(names.some(p => /new\.jsonl$/.test(p))).toBe(false);
    expect(names.some(p => /settings\.json$/.test(p))).toBe(false);
  });
});

describe('apply', () => {
  const ledger = jobsText([{ job: 'RQ-DONE-1', event: 'outcome', state: 'MERGED', ts: '2026-10-20T00:00:00Z' }]);

  it('deletes, compresses and reports freed bytes per class', async () => {
    const stale = file('.ashlr/agent-logs/old.jsonl', 2048, 60);
    const compressMe = file('.ashlr/agent-logs/mid.jsonl', 2048, 20);
    file('.ashlr/agent-logs/live.jsonl', 2048, 1);
    const plan = await planDiskMaint(baseDeps({ readJobs: HEALTHY(ledger), only: new Set(['ashlr-logs']) }));
    const applied = await applyDiskMaint(plan, { roots });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(compressMe)).toBe(false);
    expect(existsSync(`${compressMe}.gz`)).toBe(true);
    expect(gunzipSync(readFileSync(`${compressMe}.gz`))).toHaveLength(2048);
    expect(existsSync(join(home, '.ashlr/agent-logs/live.jsonl'))).toBe(true);
    const cls = applied.classes.find(c => c.id === 'ashlr-logs')!;
    expect(cls.results.filter(r => r.status === 'done')).toHaveLength(2);
    expect(cls.freedBytes).toBeGreaterThan(2048); // delete freed 2K, compress freed most of another 2K
    expect(applied.totals.freedBytes).toBe(cls.freedBytes);
  });

  it('rotates a live log into a verified .gz', async () => {
    const live = file('.ashlr-runs/disk.log', 4096, 1);
    const plan = await planDiskMaint(baseDeps({ readJobs: HEALTHY(''), only: new Set(['run-logs']), policy: { rotateBytes: 100 } }));
    const applied = await applyDiskMaint(plan, { roots });
    expect(existsSync(live)).toBe(false);
    const rotated = join(home, '.ashlr-runs');
    const gz = readdirSync(rotated).find(n => /disk\.log\.rotate-\d+\.gz$/.test(n));
    expect(gz).toBeTruthy();
    expect(gunzipSync(readFileSync(join(rotated, gz!)))).toHaveLength(4096);
    expect(applied.totals.freedBytes).toBeGreaterThan(0);
  });

  it('refuses a file that changed since the plan ran', async () => {
    const f = file('.ashlr/agent-logs/changing.jsonl', 2048, 60);
    const plan = await planDiskMaint(baseDeps({ only: new Set(['ashlr-logs']) }));
    writeFileSync(f, Buffer.alloc(4096, 9)); // changed after planning
    const applied = await applyDiskMaint(plan, { roots });
    expect(existsSync(f)).toBe(true);
    expect(applied.classes[0]!.results[0]!.status).toBe('refused');
  });

  it('removes a stale directory only inside managed roots', async () => {
    const recovery = dir('.ashlr/native-profiles/codex-a-recovery-20261001', 40);
    writeFileSync(join(recovery, 'blob'), 'x');
    age(recovery, 40);
    const plan = await planDiskMaint(baseDeps({ only: new Set(['recovery-dirs']) }));
    const applied = await applyDiskMaint(plan, { roots });
    expect(existsSync(recovery)).toBe(false);
    expect(applied.totals.freedBytes).toBeGreaterThan(0);
  });

  it('refuses a directory that changed since the plan ran', async () => {
    const recovery = dir('.ashlr/native-profiles/claude-a-recovery-20261001', 40);
    const plan = await planDiskMaint(baseDeps({ only: new Set(['recovery-dirs']) }));
    writeFileSync(join(recovery, 'new-blob'), 'x'); // dir mtime moves
    const applied = await applyDiskMaint(plan, { roots });
    expect(existsSync(recovery)).toBe(true);
    expect(applied.classes[0]!.results[0]!.status).toBe('refused');
  });

  it('runs git worktree remove from the owning repo, never --force', async () => {
    const wt = dir('.ashlr-runs/wt/RQ-OLD-MERGED', 5);
    const ledger = jobsText([
      { job: 'RQ-OLD-MERGED', event: 'finish', ts: '2026-10-01T00:00:00Z' },
      { job: 'RQ-OLD-MERGED', event: 'outcome', state: 'MERGED', ts: '2026-10-01T00:05:00Z' },
    ]);
    const calls: string[][] = [];
    const runner = async (_file: string, args: string[]) => {
      calls.push(args);
      if (args.includes('rev-parse')) return `${home}/repo/.git\n`;
      rmSync(wt, { recursive: true });
      return '';
    };
    const plan = await planDiskMaint(baseDeps({ readJobs: HEALTHY(ledger), only: new Set(['worktrees-runs']) }));
    const applied = await applyDiskMaint(plan, { ...baseDeps({ readJobs: HEALTHY(ledger) }), runner });
    expect(calls.some(a => a.includes('worktree') && a.includes('remove'))).toBe(true);
    expect(calls.flat().some(a => a === '--force' || a === '-f')).toBe(false);
    expect(applied.classes[0]!.results[0]!.status).toBe('done');
  });

  it('rechecks leases created after planning before calling Git', async () => {
    const name = 'RQ-NEW-LEASE';
    dir(`Projects/ashlrai/wt/${name}`, 5);
    const deps = baseDeps({ readJobs: HEALTHY(jobsText([
      { job: name, event: 'outcome', state: 'CLOSED', ts: '2026-10-01T00:05:00Z' },
    ])), only: new Set(['worktrees-jobs']) });
    const plan = await planDiskMaint(deps);
    expect(plan.classes[0]!.candidates).toHaveLength(1);
    file(`.ashlr-runs/queue/run/${name}.batched`, 1, 0);
    const applied = await applyDiskMaint(plan, { ...deps, runner: async () => { throw new Error('must not run Git'); } });
    expect(applied.totals.refusals).toBe(1);
    expect(applied.totals.failures).toBe(0);
  });

  it('preserves a worktree containing protected payloads, including when they appear after planning', async () => {
    const name = 'RQ-WITH-PAYLOAD';
    dir(`Projects/ashlrai/wt/${name}`, 5);
    const deps = baseDeps({ readJobs: HEALTHY(jobsText([
      { job: name, event: 'outcome', state: 'CLOSED', ts: '2026-10-01T00:05:00Z' },
    ])), only: new Set(['worktrees-jobs']) });
    const plan = await planDiskMaint(deps);
    expect(plan.classes[0]!.candidates).toHaveLength(1);
    file(`Projects/ashlrai/wt/${name}/ignored/model.gguf`, 1, 0);
    expect((await planDiskMaint(deps)).classes[0]!.protectReasons).toEqual({ 'protected-payload': 1 });
    const applied = await applyDiskMaint(plan, { ...deps, runner: async () => { throw new Error('must not run Git'); } });
    expect(applied.classes[0]!.results[0]).toMatchObject({ status: 'refused', detail: 'protected-payload' });
  });
});

describe('completed job artifacts', () => {
  const completed = jobsText([
    { job: 'RQ-DONE', event: 'launch' },
    { job: 'RQ-DONE', event: 'finish' },
    { job: 'RQ-DONE', event: 'outcome', state: 'MERGED' },
  ]);
  const artifact = '.ashlr-runs/RQ-DONE.publish.prev-123';

  it('reports the 115 GB shortfall from stale results without changing files', async () => {
    const path = file(artifact, 2048, 60);
    const protectedFile = file('Documents/keep.publish.prev-123', 4096, 60);
    file('.ashlr/agent-logs/old.log', 8192, 60);
    const plan = await planDiskMaint(baseDeps({ readJobs: HEALTHY(completed), freeBytes: () => 115e9 }));
    expect(plan.reclaimAdvice).toMatchObject({ status: 'insufficient', targetFreeGb: 150,
      candidateBytes: 2048, neededBytes: 35e9, estimatedShortfallBytes: 35e9 - 2048 });
    expect(plan.totals.bytes).toBeGreaterThan(plan.reclaimAdvice.candidateBytes!);
    expect(formatDiskMaint(plan)).toContain(plan.reclaimAdvice.message);
    expect(readFileSync(path)).toEqual(Buffer.alloc(2048, 7));
    expect(readFileSync(protectedFile)).toEqual(Buffer.alloc(4096, 7));
  });

  it('keeps unknowns distinct and never promises physical recovery', async () => {
    file(artifact, 2048, 60);
    const deps = baseDeps({ readJobs: HEALTHY(completed), only: new Set(['job-artifacts']) });
    for (const free of [null, NaN, -1]) {
      expect((await planDiskMaint({ ...deps, freeBytes: () => free })).reclaimAdvice)
        .toMatchObject({ status: 'unknown', neededBytes: null, estimatedShortfallBytes: null });
    }
    for (const over of [{ readJobs: async () => ({ state: 'degraded' as const, text: '' }) },
      { readJobs: HEALTHY(completed + '{bad\n') },
      { only: new Set<'caches'>(['caches']) }]) {
      expect((await planDiskMaint({ ...deps, freeBytes: () => 115e9, ...over })).reclaimAdvice)
        .toMatchObject({ status: 'unknown', candidateBytes: null, estimatedShortfallBytes: null });
    }
    const advice = (await planDiskMaint({ ...deps, freeBytes: () => 150e9 - 1 })).reclaimAdvice;
    expect(advice).toMatchObject({ status: 'review', neededBytes: 1, estimatedShortfallBytes: 0 });
    expect(advice.message).toContain('physical savings are unverified');
    expect((await planDiskMaint({ ...deps, freeBytes: () => 150e9 })).reclaimAdvice.status).toBe('above-target');
    expect((await planDiskMaint({ ...deps, freeBytes: () => 150e9 - 2049 })).reclaimAdvice.message).toContain('<0.001 GB');
  });

  it('reclaims an old archived result only after completion, reporting bytes and current free space', async () => {
    const path = file(artifact, 2048, 60);
    const plan = await planDiskMaint(baseDeps({ readJobs: HEALTHY(completed), only: new Set(['job-artifacts']) }));
    expect(plan.classes[0]!.candidates).toHaveLength(1);
    const result = await applyDiskMaint(plan, { roots, readJobs: HEALTHY(completed), freeBytes: () => 123e9 });
    expect(existsSync(path)).toBe(false);
    expect(result.totals.freedBytes).toBe(2048);
    expect(result.freeGb).toBe(123);
  });

  it('reads completion evidence in the jobs-ledger dialect', async () => {
    const path = file(artifact, 2048, 60);
    // jobId/type/kind aliases plus an eventless reconciler MERGED row.
    const dialect = jobsText([
      { jobId: 'RQ-DONE', type: 'launch' },
      { jobId: 'RQ-DONE', kind: 'finish' },
      { jobId: 'RQ-DONE', prUrl: 'https://github.com/o/r/pull/1', outcome: 'MERGED', mergedAt: '2026-10-20T00:05:00Z', source: 'metrics-outcomes-reconciler' },
    ]);
    const plan = await planDiskMaint(baseDeps({ readJobs: HEALTHY(dialect), only: new Set(['job-artifacts']) }));
    expect(plan.classes[0]!.candidates).toHaveLength(1);
    // A publish claim carrying a phase but no reconciler source is not completion.
    const unsourced = jobsText([
      { jobId: 'RQ-DONE', event: 'launch' },
      { jobId: 'RQ-DONE', event: 'finish' },
      { jobId: 'RQ-DONE', event: 'publish', prUrl: 'https://github.com/o/r/pull/1', outcome: 'MERGED' },
    ]);
    const kept = await planDiskMaint(baseDeps({ readJobs: HEALTHY(unsourced), only: new Set(['job-artifacts']) }));
    expect(kept.classes[0]!.candidates).toHaveLength(0);
    expect(existsSync(path)).toBe(true);
  });

  it('preserves workspaces, activity markers, fresh artifacts and later attempts', async () => {
    file(artifact, 2048, 60);
    file('.ashlr-runs/RQ-DONE.publish.prev-124', 100, 1);
    for (const marker of ['.ashlr-runs/RQ-DONE.base', '.ashlr-runs/queue/run/RQ-DONE.dispatched',
      '.ashlr-runs/queue/run/RQ-DONE.reaping', '.ashlr-runs/wt/RQ-DONE', 'Projects/ashlrai/wt/RQ-DONE']) {
      const path = file(marker, 1, 1);
      const plan = await planDiskMaint(baseDeps({ readJobs: HEALTHY(completed), only: new Set(['job-artifacts']), freeBytes: () => 115e9 }));
      expect(plan.classes[0]!.candidates).toHaveLength(0);
      expect(plan.reclaimAdvice).toMatchObject({ status: 'insufficient', candidateBytes: 0, estimatedShortfallBytes: 35e9 });
      rmSync(path);
    }
    for (const text of [completed + jobsText([{ job: 'RQ-DONE', event: 'launch' }]), completed + '{bad\n']) {
      const plan = await planDiskMaint(baseDeps({ readJobs: HEALTHY(text), only: new Set(['job-artifacts']) }));
      expect(plan.classes[0]!.candidates).toHaveLength(0);
    }
  });

  it('rechecks activity and ledger at apply time and fails closed', async () => {
    const path = file(artifact, 2048, 60);
    const plan = await planDiskMaint(baseDeps({ readJobs: HEALTHY(completed), only: new Set(['job-artifacts']) }));
    file('.ashlr-runs/queue/run/RQ-DONE.dispatched', 1, 1);
    expect((await applyDiskMaint(plan, { roots, readJobs: HEALTHY(completed) })).totals.refusals).toBe(1);
    rmSync(join(home, '.ashlr-runs/queue/run/RQ-DONE.dispatched'));
    expect((await applyDiskMaint(plan, { roots, readJobs: HEALTHY(completed + jobsText([{ job: 'RQ-DONE', event: 'launch' }])) })).totals.refusals).toBe(1);
    expect((await applyDiskMaint(plan, { roots, readJobs: async () => ({ state: 'degraded', text: '' }) })).totals.refusals).toBe(1);
    expect(existsSync(path)).toBe(true);
  });
});

describe('cli', () => {
  const run = async (argv: string[], planDeps: MaintDeps = {}) => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await cmdDiskMaint(argv, { roots, now: NOW, plan: planDeps, output: { log: s => logs.push(s), error: s => errors.push(s) } });
    return { code, logs, errors };
  };

  it('--help anywhere wins, even beside --apply', async () => {
    const { code, logs } = await run(['--apply', '--help']);
    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/dry run/i);
  });

  it('rejects bad classes, bad flags and bad usage', async () => {
    expect((await run(['--only', 'bogus'])).code).toBe(2);
    expect((await run(['--allow', 'bogus'])).code).toBe(2);
    expect((await run(['--allow', 'run-logs'])).code).toBe(2); // --allow is for gated classes
    expect((await run(['--nope'])).code).toBe(2);
    expect((await run(['--apply', '--apply'])).code).toBe(2);
    expect((await run(['--compress-days', 'abc'])).code).toBe(2);
    expect((await run(['--compress-days', '50', '--prune-days', '10'])).code).toBe(2);
    expect((await run(['--home', 'relative/path'])).code).toBe(2);
    expect((await run(['--worktree', '../RQ-ESCAPE'])).code).toBe(2);
    expect((await run(['--worktree', 'RQ-VALID', '--only', 'ashlr-logs'])).code).toBe(2);
  });

  it('scopes post-push cleanup to one job, defaults to dry run, and keeps leases', async () => {
    const job = 'RQ-DEVINCLOUD-ONE';
    const other = 'RQ-DEVINCLOUD-TWO';
    const wt = dir(`Projects/ashlrai/wt/${job}`, 0);
    const unrelated = dir(`Projects/ashlrai/wt/${other}`, 0);
    const oldLog = file('.ashlr/agent-logs/unrelated.jsonl', 1024, 60);
    const headSha = 'a'.repeat(40);
    const ts = new Date(NOW - DAY).toISOString();
    const receipt = (id: string) => ({ jobId: id, event: 'publish', prUrl: 'https://github.com/ashlrai/phantom/pull/1', ts, headSha });
    const calls: string[][] = [];
    const deps = {
      ...baseDeps({ readJobs: HEALTHY(jobsText([receipt(job), receipt(other)])),
        lookupWorktreePulls: async urls => ({ pulls: urls.map(url => ({ url, state: 'MERGED', at: NOW - DAY, prHead: headSha })) }),
        worktreeHasUnpushed: async (path, head) => path !== wt || head !== headSha }),
      now: NOW,
      runner: async (_file: string, args: string[]) => {
        calls.push(args);
        if (args.includes('rev-parse')) return `${home}/repo/.git\n`;
        rmSync(wt, { recursive: true });
        return '';
      },
    };
    const args = ['--worktree', job, '--only', 'worktrees-jobs'];
    const preview = await run([...args, '--json'], deps);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.logs.join(''))).toMatchObject({
      apply: false, classes: [{ id: 'worktrees-jobs', scanned: 1, reapable: 1, protected: 0, reapReasons: { merged: 1 } }],
    });
    expect(existsSync(wt)).toBe(true);
    expect(calls).toEqual([]);
    const lease = file(`.ashlr-runs/queue/run/${job}.dispatched`, 1, 0);
    expect(await cmdDiskMaint([...args, '--apply'], { ...deps, output: { log: () => {}, error: () => {} } })).toBe(0);
    expect(calls).toEqual([]);
    rmSync(lease);
    expect(await cmdDiskMaint([...args, '--apply'], { ...deps, output: { log: () => {}, error: () => {} } })).toBe(0);
    expect(calls.at(-1)).toEqual(['-C', `${join(home, 'repo')}/`, 'worktree', 'remove', '--', wt]);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(oldLog)).toBe(true);
  });

  it('dry run --json prints the plan with bytes by class', async () => {
    file('.ashlr/agent-logs/old.jsonl', 2048, 60);
    const { code, logs } = await run(['--json'], { readJobs: HEALTHY('') });
    expect(code).toBe(0);
    const view = JSON.parse(logs.join('')) as { schema: string; apply: boolean; classes: { id: string; bytes: number }[]; totals: { bytes: number }; diskguardReuseOnlyGb: number };
    expect(view.schema).toBe('disk-maint.v1');
    expect(view.apply).toBe(false);
    expect(view.diskguardReuseOnlyGb).toBe(100);
    const cls = view.classes.find(c => c.id === 'ashlr-logs')!;
    expect(cls.bytes).toBe(2048);
    expect(view.totals.bytes).toBeGreaterThanOrEqual(2048);
    expect(existsSync(join(home, '.ashlr/agent-logs/old.jsonl'))).toBe(true);
  });

  it('--apply frees bytes and reports results', async () => {
    file('.ashlr/agent-logs/old.jsonl', 2048, 60);
    const { code, logs } = await run(['--apply', '--only', 'ashlr-logs'], { readJobs: HEALTHY('') });
    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/freed/i);
    expect(existsSync(join(home, '.ashlr/agent-logs/old.jsonl'))).toBe(false);
  });

  it('shares advice with JSON and drops the pre-apply estimate after cleanup', async () => {
    const deps = baseDeps({ freeBytes: () => 115e9 });
    const preview = await run(['--json', '--only', 'job-artifacts'], deps);
    const view = JSON.parse(preview.logs.join(''));
    expect(preview.code).toBe(0);
    expect(view.reclaimAdvice).toMatchObject({ scope: 'listed-job-artifacts',
      basis: 'pre-apply-logical-bytes', status: 'insufficient', estimatedShortfallBytes: 35e9 });
    expect((await run(['--only', 'job-artifacts'], deps)).logs).toContain(view.reclaimAdvice.message);
    const applied = await run(['--apply', '--json', '--only', 'job-artifacts'], deps);
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.logs.join('')).reclaimAdvice).toBeNull();
  });
});

describe('schedule', () => {
  it('macOS: per-user LaunchAgent at minute 43, report-only by default', () => {
    const [u] = diskMaintSchedule({ phmPath: '/opt/phm/bin/phm', apply: false, platform: 'darwin', home: '/Users/m' });
    expect(u!.path).toBe('/Users/m/Library/LaunchAgents/ai.ashlr.phm.disk-maint.plist');
    expect(u!.contents).toContain('<string>disk-maint</string><string>--json</string>');
    expect(u!.contents).toContain('<key>Minute</key><integer>43</integer>');
    expect(u!.contents).not.toContain('--apply');
  });

  it('linux: user service + timer; --apply only when chosen', () => {
    const units = diskMaintSchedule({ phmPath: '/usr/local/bin/phm', apply: true, hour: 4, platform: 'linux', home: '/home/m' });
    expect(units.map(u => u.path)).toEqual(['/home/m/.config/systemd/user/phm-disk-maint.service', '/home/m/.config/systemd/user/phm-disk-maint.timer']);
    expect(units[0]!.contents).toContain('"--apply"');
    expect(units[1]!.contents).toContain('OnCalendar=*-*-* 04:43:00');
    expect(units[0]!.contents).not.toContain('--allow');
  });

  it('rejects invalid hours and unsafe paths like the steward schedule', () => {
    for (const hour of [NaN, Infinity, -1, 24, 3.5]) {
      expect(() => diskMaintSchedule({ phmPath: '/bin/phm', apply: false, hour, platform: 'linux' })).toThrow(/hour/);
    }
    expect(() => diskMaintSchedule({ phmPath: 'relative', apply: false, platform: 'linux' })).toThrow(/paths/);
    expect(() => diskMaintSchedule({ phmPath: '/x\nExecStart=/bin/sh', apply: false, platform: 'linux' })).toThrow(/paths/);
    expect(() => diskMaintSchedule({ phmPath: '/bin/phm', apply: false, platform: 'win32' })).toThrow(/macOS and Linux/);
  });

  it('schedules a separate 30-minute job for the two worktree classes only', () => {
    const opts = { phmPath: '/bin/phm', apply: true, worktrees: true };
    const [mac] = diskMaintSchedule({ ...opts, platform: 'darwin' });
    expect(mac!.path).toMatch(/disk-maint-worktrees\.plist$/);
    expect(mac!.contents).toContain('<key>StartInterval</key><integer>1800</integer>');
    expect(mac!.contents).toContain('<string>--only</string><string>worktrees-runs,worktrees-jobs</string>');
    const [service, timer] = diskMaintSchedule({ ...opts, platform: 'linux' });
    expect(service!.contents).toContain('"--apply" "--json" "--only" "worktrees-runs,worktrees-jobs"');
    expect(timer!.contents).toContain('OnCalendar=*-*-* *:00,30:00');
  });
});
