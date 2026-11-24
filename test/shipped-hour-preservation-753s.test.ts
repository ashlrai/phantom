import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { cmdShipped } from '../src/cli/shipped.js';
import { readHourShipped } from '../src/core/fleet/shipped-hour.js';

const now = Date.parse('2026-11-20T12:00:00Z');
it('reads default-branch history through the handler, excluding a feature-only commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ship-preserve-'));
  try {
    const repo = join(root, 'app'); mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-20T11:55:00Z', GIT_COMMITTER_DATE: '2026-11-20T11:55:00Z' } });
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(repo, 'base'), 'base'); git('add', '.'); git('commit', '-qm', 'Merged work (#1)');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-qb', 'feature'); writeFileSync(join(repo, 'feature'), 'feature'); git('add', '.'); git('commit', '-qm', 'Unmerged work (#2)');
    const out: string[] = [];
    const code = await cmdShipped(['--since', '1h', '--json'], { now: () => now, out: line => out.push(line), hour: () => readHourShipped({ now, roots: [root] }) });
    expect(code).toBe(0);
    const report = JSON.parse(out[0]!);
    expect(report.items.map((item: { number: number }) => item.number)).toEqual([1]);
    expect(report.items[0]).toMatchObject({ lane: null, openToMergeSeconds: null });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('returns unknown and a nonzero status for an unreadable source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ship-unknown-'));
  try {
    mkdirSync(join(root, 'bad')); mkdirSync(join(root, 'bad', '.git'));
    const out: string[] = [];
    const code = await cmdShipped(['--since', '1h', '--json'], { now: () => now, out: line => out.push(line), hour: () => readHourShipped({ now, roots: [root] }) });
    expect(code).toBe(1); expect(JSON.parse(out[0]!)).toMatchObject({ complete: false, total: null });
    expect(await cmdShipped(['--since', '1h', '--repo', 'app'], { err: () => {} })).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('retains 24h dispatch and rejects conflicting flags', async () => {
  const out: string[] = [];
  let called = 0;
  const fleet: NonNullable<Parameters<typeof cmdShipped>[1]>['fleet'] = async () => { called++; return { complete: true, totals: { merged: 0, mergedPerHour: 0, medianOpenToMergeSeconds: null }, items: [] } as Awaited<ReturnType<NonNullable<Parameters<typeof cmdShipped>[1]>['fleet']>>; };
  expect(await cmdShipped(['--since', '24h', '--json'], { now: () => now, out: line => out.push(line), fleet })).toBe(0);
  expect(called).toBe(1); expect(JSON.parse(out[0]!).complete).toBe(true);
  expect(await cmdShipped(['--since', '24h', '--json', '--md'], { err: () => {}, fleet })).toBe(2);
});
