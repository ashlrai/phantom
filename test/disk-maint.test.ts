/**
 * disk-maint: the protect-list holds under every flag, and each reclaim
 * class attributes and frees the bytes it claims. Uses real temp trees like
 * the steward tests; git worktree removal goes through an injected runner.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planDiskMaint, type MaintDeps, type MaintRoots } from '../src/core/disk-maint/plan.js';
import { applyDiskMaint } from '../src/core/disk-maint/apply.js';
import { protectedReason, protectedRoots, resolveMaintRoots } from '../src/core/disk-maint/protect.js';
import { diskMaintSchedule } from '../src/core/disk-maint/schedule.js';
import { cmdDiskMaint } from '../src/cli/disk-maint.js';

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
    const applied = await applyDiskMaint(plan, { roots, runner });
    expect(calls.some(a => a.includes('worktree') && a.includes('remove'))).toBe(true);
    expect(calls.flat().some(a => a === '--force' || a === '-f')).toBe(false);
    expect(applied.classes[0]!.results[0]!.status).toBe('done');
  });
});

describe('completed job artifacts', () => {
  const completed = jobsText([
    { job: 'RQ-DONE', event: 'launch' },
    { job: 'RQ-DONE', event: 'finish' },
    { job: 'RQ-DONE', event: 'outcome', state: 'MERGED' },
  ]);
  const artifact = '.ashlr-runs/RQ-DONE.publish.prev-123';

  it('reclaims an old archived result only after completion, reporting bytes and current free space', async () => {
    const path = file(artifact, 2048, 60);
    const plan = await planDiskMaint(baseDeps({ readJobs: HEALTHY(completed), only: new Set(['job-artifacts']) }));
    expect(plan.classes[0]!.candidates).toHaveLength(1);
    const result = await applyDiskMaint(plan, { roots, readJobs: HEALTHY(completed), freeBytes: () => 123e9 });
    expect(existsSync(path)).toBe(false);
    expect(result.totals.freedBytes).toBe(2048);
    expect(result.freeGb).toBe(123);
  });

  it('preserves workspaces, activity markers, fresh artifacts and later attempts', async () => {
    file(artifact, 2048, 60);
    file('.ashlr-runs/RQ-DONE.publish.prev-124', 100, 1);
    for (const marker of ['.ashlr-runs/RQ-DONE.base', '.ashlr-runs/queue/run/RQ-DONE.dispatched',
      '.ashlr-runs/queue/run/RQ-DONE.reaping', '.ashlr-runs/wt/RQ-DONE', 'Projects/ashlrai/wt/RQ-DONE']) {
      const path = file(marker, 1, 1);
      const plan = await planDiskMaint(baseDeps({ readJobs: HEALTHY(completed), only: new Set(['job-artifacts']) }));
      expect(plan.classes[0]!.candidates).toHaveLength(0);
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
});
