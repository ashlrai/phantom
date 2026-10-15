import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendUserBacklogItems, readCloudBacklog, readUserBacklogItems, validDoneWhen } from '../src/core/cloud/backlog.js';
import { checkDoneWhen } from '../src/core/cloud/backlog-done.js';
import { BUILTIN_IMPROVEMENT_BACKLOG } from '../src/core/cloud/improvement-backlog.js';
import { writeCloudTask } from '../src/core/cloud/store.js';
import type { CloudBacklogItem, CloudTaskV1 } from '../src/core/cloud/types.js';
import { appendLedger, kindOf, outcomesLedgerPath, readLedger, scoreOutcomes, type MetricSpec } from '../src/core/improve/outcomes.js';
import { backlogProposalId, backlogRegistrations } from '../src/core/improve/backlog-sync.js';
import { cmdImprove } from '../src/cli/improve.js';

const metric: MetricSpec = { name: 'gate-ms', direction: 'decrease', runner: { kind: 'npm', script: 'bench:gate' } };
const A = 'a'.repeat(40), B = 'b'.repeat(40);
let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
  delete process.env.ASHLR_HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-backlog-')));
  process.env.HOME = home;
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const user = (id: string, area: string, priority: 1 | 2 | 3 = 3, extra: Partial<CloudBacklogItem> = {}): CloudBacklogItem =>
  ({ id, title: `Item ${id}`, prompt: `Do ${id}`, area, priority, ...extra });
const credit = (id: string, area: string, head: number) => {
  appendLedger({ type: 'registered', proposalId: id, title: id, proposalKind: kindOf(area), source: { kind: 'deterministic', rule: 'cloud-backlog' }, metric, predictedDelta: null });
  appendLedger({ type: 'measured', proposalId: id, phase: 'base', sha: A, value: 100, reason: null });
  appendLedger({ type: 'measured', proposalId: id, phase: 'head', sha: B, value: head, reason: null });
};

describe('backlog ordering by realized leverage', () => {
  it('keeps priority first and reorders areas within a priority by measured outcomes', () => {
    appendUserBacklogItems([user('u-slow', 'Docs'), user('u-fast', 'Perf Gate'), user('u-new', 'Tests'), user('u-top', 'Docs', 1)]);
    const before = readCloudBacklog([], new Date()).items.map((i) => i.id).filter((id) => id.startsWith('u-'));
    expect(before).toEqual(['u-top', 'u-slow', 'u-fast', 'u-new']);
    credit('1111111111', 'Perf Gate', 80); // decrease metric: 100 -> 80 improved
    credit('2222222222', 'Docs', 120); // regressed
    const after = readCloudBacklog([], new Date()).items.map((i) => i.id).filter((id) => id.startsWith('u-'));
    expect(after).toEqual(['u-top', 'u-fast', 'u-new', 'u-slow']);
  });

  it('falls back to the static order when the ledger is broken', () => {
    appendUserBacklogItems([user('u-slow', 'Docs'), user('u-fast', 'Perf Gate')]);
    credit('1111111111', 'Perf Gate', 80);
    fs.appendFileSync(outcomesLedgerPath(), 'not json\n');
    expect(readLedger().intact).toBe(false);
    expect(readCloudBacklog([], new Date()).items.map((i) => i.id).filter((id) => id.startsWith('u-'))).toEqual(['u-slow', 'u-fast']);
  });

  it('accepts a valid metric on user items and skips items with an unsafe one', () => {
    appendUserBacklogItems([user('u-m', 'Perf', 3, { metric })]);
    const raw = JSON.parse(fs.readFileSync(path.join(home, '.ashlr', 'cloud', 'backlog.json'), 'utf8'));
    raw.items.push({ ...user('u-bad', 'Perf'), metric: { ...metric, runner: { kind: 'node', path: '../x.mjs' } } });
    fs.writeFileSync(path.join(home, '.ashlr', 'cloud', 'backlog.json'), JSON.stringify(raw));
    const items = readUserBacklogItems();
    expect(items.find((i) => i.id === 'u-m')?.metric).toEqual(metric);
    expect(items.find((i) => i.id === 'u-bad')).toBeUndefined();
    expect(BUILTIN_IMPROVEMENT_BACKLOG.length).toBeGreaterThan(0);
  });
});

describe('backlog to ledger sync', () => {
  const task = (id: string, backlogItemId: string | null, pr: CloudTaskV1['pr']) => ({ id, repo: 'ashlrai/phantom', title: id, backlogItemId, pr });
  const pr = (number: number, state: 'open' | 'merged' | 'closed' = 'open') => ({ number, url: `https://github.com/ashlrai/phantom/pull/${number}`, state, draft: true, title: 't' });

  it('registers only metric-bearing items with a live PR, once, as the deterministic baseline', () => {
    const items = [user('m1', 'Perf Gate', 2, { metric }), user('m2', 'Docs')];
    const tasks = [task('ct_1', 'm1', pr(9)), task('ct_2', 'm2', pr(10)), task('ct_3', 'm1', null), task('ct_4', 'm1', pr(11, 'closed'))];
    const events = backlogRegistrations(tasks, items, []);
    expect(events).toEqual([
      { type: 'registered', proposalId: backlogProposalId('ct_1'), title: 'Item m1', proposalKind: 'perf-gate', source: { kind: 'deterministic', rule: 'cloud-backlog' }, metric, predictedDelta: null },
      { type: 'pr', proposalId: backlogProposalId('ct_1'), repository: 'ashlrai/phantom', number: 9 },
    ]);
    for (const e of events) appendLedger(e);
    expect(backlogRegistrations(tasks, items, readLedger().records)).toEqual([]);
    expect(scoreOutcomes(readLedger().records)[0]).toMatchObject({ status: 'unknown', pr: { number: 9 } });
  });

  it('phm improve sync-backlog registers stored cloud tasks', async () => {
    appendUserBacklogItems([user('m1', 'Perf Gate', 1, { metric })]);
    const now = new Date().toISOString();
    writeCloudTask({ v: 1, id: 'ct_20261015T0100_abcdef', repo: 'ashlrai/phantom', baseBranch: 'master', branch: 'ashlr-cloud/ct_20261015T0100_abcdef',
      title: 'Item m1', prompt: 'Do m1', origin: 'self-improve', requestedBy: 'self-improve', seat: 's', sessionId: null, sessionUrl: null,
      state: 'pr-open', stateReason: null, failure: null, createdAt: now, launchedAt: now, updatedAt: now, pr: pr(12), report: null,
      estimatedCostUsd: 3, backlogItemId: 'm1', needsYouId: null } as unknown as CloudTaskV1);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdImprove(['sync-backlog'])).toBe(0);
    expect(String(log.mock.calls.at(-1)![0])).toMatch(/registered 1/);
    expect(await cmdImprove(['sync-backlog'])).toBe(0);
    expect(String(log.mock.calls.at(-1)![0])).toMatch(/No new/);
  });
});

describe('backlog items already satisfied', () => {
  it('validates doneWhen and keeps it on user items', () => {
    appendUserBacklogItems([user('d1', 'Perf', 3, { doneWhen: { path: 'test/x.test.ts', contains: 'budget' } })]);
    expect(readUserBacklogItems().find((i) => i.id === 'd1')?.doneWhen).toEqual({ path: 'test/x.test.ts', contains: 'budget' });
    for (const bad of [{ path: '../etc/passwd' }, { path: '/abs' }, { path: 'a/./b' }, { path: 'a b' }, { path: 'x', contains: '' }]) {
      expect(validDoneWhen(bad)).toBeNull();
    }
  });

  it('checkDoneWhen reads the default branch and fails open', async () => {
    const item = user('d2', 'Perf', 3, { doneWhen: { path: 'package.json', contains: '--budget-kb 35' } });
    const gh = (res: { ok: boolean; stdout?: string; stderr?: string }) => async (args: string[]) => {
      expect(args).toEqual(['api', '-H', 'Accept: application/vnd.github.raw', 'repos/ashlrai/phantom/contents/package.json']);
      return { stdout: '', stderr: '', ...res };
    };
    expect(await checkDoneWhen(item, 'ashlrai/phantom', gh({ ok: true, stdout: '"check": "--budget-kb 354"' }))).toBe('satisfied');
    expect(await checkDoneWhen(item, 'ashlrai/phantom', gh({ ok: true, stdout: '"check": "--budget-kb 370"' }))).toBe('open');
    expect(await checkDoneWhen(item, 'ashlrai/phantom', gh({ ok: false, stderr: 'gh: Not Found (HTTP 404)' }))).toBe('open');
    expect(await checkDoneWhen(item, 'ashlrai/phantom', gh({ ok: false, stderr: 'connection reset' }))).toBe('unknown');
  });
});
