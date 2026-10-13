import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultStewardPolicy, runSteward } from '../src/core/steward/disk.js';

let home: string;
const now = Date.now();
const file = (rel: string, kb: number, ageDays: number) => {
  const p = join(home, rel); mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, Buffer.alloc(kb * 1024, 7)); const t = (now - ageDays * 86_400_000) / 1000; utimesSync(p, t, t); return p;
};
const root = (policy: ReturnType<typeof defaultStewardPolicy>, id: string) => policy.roots.find((r) => r.id === id)!;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'phm-steward-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('steward disk guardrails', () => {
  it('dry run reports but changes nothing', () => {
    const old = file('.codex/sessions/2026/08/a.jsonl', 10, 60);
    const r = runSteward(defaultStewardPolicy(home), { home, now });
    expect(r.applied).toBe(false);
    expect(r.roots.find((x) => x.id === 'codex-sessions')!.reclaimable.files).toBe(1);
    expect(existsSync(old)).toBe(true);
  });

  it('deletes Phantom-owned logs by retention + quota, keeps recent/live, never follows symlinks', () => {
    const old = file('.ashlr/logs/old.log', 10, 30);
    const mid = file('.ashlr/logs/mid.log', 600, 3);
    const recent = file('.ashlr/logs/recent.log', 300, 2);
    const live = file('.ashlr/logs/live.log', 600, 0);
    const outside = file('precious/keep.txt', 1, 100);
    symlinkSync(join(home, 'precious'), join(home, '.ashlr/logs/link'));
    const policy = defaultStewardPolicy(home);
    root(policy, 'ashlr-logs').quotaMB = 1;
    const r = runSteward(policy, { home, now, apply: true });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(mid)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(outside)).toBe(true);
    expect(r.deleted.files).toBe(2);
  });

  it('archives cold vendor sessions (verified gzip) instead of deleting; active sessions untouched', () => {
    const cold = file('.codex/sessions/2026/08/rollout-a.jsonl', 50, 60);
    const active = file('.codex/sessions/2026/10/rollout-b.jsonl', 50, 0);
    const r = runSteward(defaultStewardPolicy(home), { home, now, apply: true });
    expect(r.deleted.files).toBe(0);
    expect(r.archived.files).toBe(1);
    expect(existsSync(cold)).toBe(false);
    expect(existsSync(active)).toBe(true);
    const gz = join(home, '.ashlr/archive/codex-sessions/2026/08/rollout-a.jsonl.gz');
    expect(gunzipSync(readFileSync(gz)).length).toBe(50 * 1024);
  });

  it('report-only roots and roots equal to home are never modified', () => {
    const f = file('x/a.log', 1, 100);
    const r = runSteward({ minAgeMinutes: 0, archiveDir: join(home, '.ashlr/archive'), roots: [{ id: 'home', path: home, retentionDays: 0, quotaMB: 0, action: 'delete' }, { id: 'x', path: join(home, 'x'), retentionDays: 0, quotaMB: 0, action: 'report' }] }, { home, now, apply: true });
    expect(r.deleted.files).toBe(0);
    expect(existsSync(f)).toBe(true);
  });

  it('refuses a root that is itself a symlink to outside home', () => {
    const outside = mkdtempSync(join(tmpdir(), 'phm-outside-'));
    try {
      const victim = join(outside, 'precious.log'); writeFileSync(victim, Buffer.alloc(2048)); const t = (now - 90 * 86_400_000) / 1000; utimesSync(victim, t, t);
      mkdirSync(join(home, '.ashlr'), { recursive: true });
      symlinkSync(outside, join(home, '.ashlr/logs'));
      const r = runSteward(defaultStewardPolicy(home), { home, now, apply: true });
      const rr = r.roots.find((x) => x.id === 'ashlr-logs')!;
      expect(rr.refused).toMatch(/symlink|outside/);
      expect(existsSync(victim)).toBe(true);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it('refuses a root whose parent component is a symlink leaving home', () => {
    const outside = mkdtempSync(join(tmpdir(), 'phm-outside-'));
    try {
      mkdirSync(join(outside, 'sessions'), { recursive: true });
      const victim = join(outside, 'sessions/old.jsonl'); writeFileSync(victim, 'x'); const t = (now - 90 * 86_400_000) / 1000; utimesSync(victim, t, t);
      symlinkSync(outside, join(home, '.codex'));
      const r = runSteward(defaultStewardPolicy(home), { home, now, apply: true });
      expect(r.roots.find((x) => x.id === 'codex-sessions')!.refused).toBeTruthy();
      expect(existsSync(victim)).toBe(true);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it('does not follow file or directory symlinks inside a root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'phm-outside-'));
    try {
      const victim = join(outside, 'v.log'); writeFileSync(victim, Buffer.alloc(4096)); const t = (now - 90 * 86_400_000) / 1000; utimesSync(victim, t, t);
      file('.ashlr/logs/real-old.log', 1, 90);
      symlinkSync(victim, join(home, '.ashlr/logs/link.log'));
      symlinkSync(outside, join(home, '.ashlr/logs/dirlink'));
      runSteward(defaultStewardPolicy(home), { home, now, apply: true });
      expect(existsSync(victim)).toBe(true);
      expect(existsSync(join(home, '.ashlr/logs/real-old.log'))).toBe(false);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});
