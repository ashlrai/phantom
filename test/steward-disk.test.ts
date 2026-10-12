import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultStewardPolicy, runSteward } from '../src/core/steward/disk.js';

let home: string;
const now = Date.now();
const file = (rel: string, kb: number, ageDays: number) => {
  const p = join(home, rel); mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, Buffer.alloc(kb * 1024)); const t = (now - ageDays * 86_400_000) / 1000; utimesSync(p, t, t); return p;
};
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'phm-steward-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('steward disk guardrails', () => {
  it('dry run reports but deletes nothing', () => {
    const old = file('.codex/sessions/2026/09/a.jsonl', 10, 30);
    const r = runSteward(defaultStewardPolicy(home), { home, now });
    expect(r.applied).toBe(false);
    expect(r.roots.find((x) => x.id === 'codex-sessions')!.reclaimable.files).toBe(1);
    expect(existsSync(old)).toBe(true);
  });

  it('apply removes retention-expired and over-quota oldest files, keeps live + recent, never follows symlinks', () => {
    const old = file('.codex/sessions/2026/09/old.jsonl', 10, 30);
    const mid = file('.codex/sessions/2026/10/mid.jsonl', 600, 3);
    const recent = file('.codex/sessions/2026/10/recent.jsonl', 300, 1);
    const live = file('.codex/sessions/2026/10/live.jsonl', 600, 0);
    const outside = file('precious/keep.txt', 1, 100);
    symlinkSync(join(home, 'precious'), join(home, '.codex/sessions/link'));
    const policy = defaultStewardPolicy(home);
    policy.roots[0]!.quotaMB = 1; // 1 MB quota
    const r = runSteward(policy, { home, now, apply: true });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(mid)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(join(home, '.codex/sessions/2026/09'))).toBe(false);
    expect(r.deleted.files).toBe(2);
  });

  it('refuses roots outside or equal to home', () => {
    file('x/a.log', 1, 100);
    const r = runSteward({ minAgeMinutes: 0, roots: [{ id: 'home', path: home, retentionDays: 0, quotaMB: 0 }] }, { home, now, apply: true });
    expect(r.deleted.files).toBe(0);
  });
});
