import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetClaudeQuota } from '../src/cli/fleet-claude-quota.js';
import type { ClaudeAccountUsageResult } from '../src/core/resources/claude-account-usage.js';

const dirs: string[] = [];
const oldPath = process.env.PATH;
let root: string;
let out: string[];
const result = (over: Partial<ClaudeAccountUsageResult>): ClaudeAccountUsageResult => ({
  schemaVersion: 1, scope: 'claude-native-auth-status', status: 'observed', reason: 'observed', loggedIn: true,
  authMethod: 'claude.ai', subscriptionType: 'max', accountHint: 'hint-secret-value', startedAt: '2026-11-02T00:00:00Z',
  finishedAt: '2026-11-02T00:00:01Z', windows: [], ...over,
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'claude-quota-verb-'));
  const bin = await mkdtemp(join(tmpdir(), 'claude-bin-'));
  dirs.push(root, bin);
  await writeFile(join(bin, 'claude'), '#!/bin/sh\n');
  await chmod(join(bin, 'claude'), 0o755);
  process.env.PATH = bin;
  out = [];
  vi.spyOn(console, 'log').mockImplementation((m: string) => { out.push(String(m)); });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  process.env.PATH = oldPath;
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});
const file = () => join(root, 'metrics/claude-quota.json');

describe('fleet claude-quota', () => {
  it('records an unsupported version with its reason and exits 0', async () => {
    const probe = async () => result({ reason: 'usage-version-unsupported' });
    expect(await cmdFleetClaudeQuota(['--root', root, '--write'], probe)).toBe(0);
    const saved = JSON.parse(await readFile(file(), 'utf8'));
    expect(saved).toMatchObject({ v: 1, fresh: false, reason: 'usage-version-unsupported', windows: [] });
    expect(out.join('\n')).toContain('usage-version-unsupported');
  });
  it('writes fresh windows and never leaks accountHint', async () => {
    const probe = async () => result({ quotaFresh: true, windows: [
      { id: 'seven_day', usedPercent: 61, resetsAt: '2026-11-07T16:02:00Z', nativeReport: { source: 'claude-usage-structured', resetDescription: 'secret prose' } },
    ] });
    expect(await cmdFleetClaudeQuota(['--root', root, '--write', '--json'], probe)).toBe(0);
    const text = await readFile(file(), 'utf8');
    expect(JSON.parse(text).windows).toEqual([{ id: 'seven_day', usedPct: 61, resetAt: '2026-11-07T16:02:00Z' }]);
    for (const s of [text, out.join('\n')]) expect(s).not.toMatch(/hint-secret-value|secret prose|max/);
  });
  it('writes nothing without --write', async () => {
    expect(await cmdFleetClaudeQuota(['--root', root], async () => result({ quotaFresh: true }))).toBe(0);
    await expect(stat(file())).rejects.toThrow();
  });
  it('exits 2 on a bad flag', async () => {
    expect(await cmdFleetClaudeQuota(['--bogus'], async () => result({}))).toBe(2);
  });
});
