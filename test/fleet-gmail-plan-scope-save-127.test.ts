import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetGmailArchivePlan } from '../src/cli/fleet-gmail-archive-plan.js';
import { gmailArchivePlanLatestPath, readGmailArchivePlanLatest, writeGmailArchivePlanLatest } from '../src/core/comms/gmail-archive-plan-latest.js';

const root = mkdtempSync(join(tmpdir(), 'gmail-scope-'));
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('saves the exact printed sample scope per inbox and respects no-save', async () => {
  const runs = join(root, 'runs');
  const dir = join(root, 'export');
  mkdirSync(dir);
  for (let i = 0; i < 4; i++) writeFileSync(join(dir, `${i}.eml`),
    `From: noreply@example.test\nMessage-ID: <${i}@example.test>\nSubject: Synthetic\n\nSynthetic body.\n`);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  async function run(inbox: string, scan: string, noSave = false) {
    log.mockClear();
    expect(await cmdFleetGmailArchivePlan(['--dir', dir, '--inbox', inbox, '--scan', scan, '--runs-dir', runs, '--json', ...(noSave ? ['--no-save'] : [])])).toBe(0);
    return JSON.parse(String(log.mock.calls[0]![0])).scope;
  }
  const first = await run('first', '2');
  expect(first).toEqual({ source: 'local-eml-export', scanned: 2, files: 4, limit: 2, truncated: true, unreadRepresentsLiveTotal: false });
  const second = await run('second', '3');
  const plans = readGmailArchivePlanLatest(runs)!.plans;
  expect(plans.find(p => p.inbox === 'first')?.scope).toEqual(first);
  expect(plans.find(p => p.inbox === 'second')?.scope).toEqual(second);
  const path = gmailArchivePlanLatestPath(runs);
  const before = readFileSync(path, 'utf8');
  await run('first', '1', true);
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(before).not.toContain(dir);
  expect(before).not.toContain('Synthetic');
});

it('keeps legacy plans readable and refuses malformed scope evidence', () => {
  const runs = join(root, 'runs');
  const base = { inbox: 'legacy', unread: 1, target: 0, archiveCount: 1, topSenders: [] };
  writeGmailArchivePlanLatest(runs, base);
  const path = gmailArchivePlanLatestPath(runs);
  const legacy = readGmailArchivePlanLatest(runs)!;
  expect(legacy.plans[0]?.scope).toBeUndefined();
  const scope = { source: 'local-eml-export', scanned: 1, files: 3, limit: 1, truncated: true, unreadRepresentsLiveTotal: false } as const;
  writeGmailArchivePlanLatest(runs, { ...base, inbox: 'new', scope: { ...scope, extra: '/private/path' } } as typeof base & { scope: typeof scope });
  expect(readGmailArchivePlanLatest(runs)?.plans.find(p => p.inbox === 'new')?.scope).toEqual(scope);
  expect(readFileSync(path, 'utf8')).not.toContain('/private/path');
  const before = readFileSync(path, 'utf8');
  for (const bad of [{ ...scope, unreadRepresentsLiveTotal: true }, { ...scope, scanned: 4 }, { ...scope, truncated: 'false' }]) {
    expect(() => writeGmailArchivePlanLatest(runs, { ...base, scope: bad as typeof scope })).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(before);
    const raw = JSON.parse(before);
    raw.plans[0].scope = bad;
    writeFileSync(path, JSON.stringify(raw));
    expect(readGmailArchivePlanLatest(runs)?.plans[0]?.scope).toBeUndefined();
    writeFileSync(path, before);
  }
});
