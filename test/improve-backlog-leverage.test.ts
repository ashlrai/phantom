import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendUserBacklogItems, readCloudBacklog, readUserBacklogItems, validDoneWhen } from '../src/core/cloud/backlog.js';
import { checkDoneWhen } from '../src/core/cloud/backlog-done.js';
import { BUILTIN_IMPROVEMENT_BACKLOG } from '../src/core/cloud/improvement-backlog.js';
import { writeCloudTask } from '../src/core/cloud/store.js';
import type { CloudBacklogItem, CloudTaskV1 } from '../src/core/cloud/types.js';
import { appendLedger, kindOf, outcomesLedgerPath, readLedger, scoreOutcomes, type LedgerEvent, type MetricSpec } from '../src/core/improve/outcomes.js';
import { backlogProposalId, backlogRegistrations, syncCloudBacklogOutcomes } from '../src/core/improve/backlog-sync.js';
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

  it('registers a superseded task against its fleet carrier PR and skips dead carriers', () => {
    const items = [user('m1', 'Perf Gate', 2, { metric })];
    const base = { repo: 'ashlrai/phantom', title: 'x', backlogItemId: 'm1', pr: pr(9, 'closed') };
    const tasks = [
      { ...base, id: 'ct_sup_open', state: 'pr-open' as const, supersededBy: { repo: 'ashlrai/phantom', number: 77 } },
      { ...base, id: 'ct_sup_merged', state: 'merged' as const, supersededBy: { repo: 'ashlrai/phantom', number: 78 } },
      { ...base, id: 'ct_sup_closed', state: 'closed' as const, supersededBy: { repo: 'ashlrai/phantom', number: 79 } },
      { ...base, id: 'ct_sup_failed', state: 'failed' as const, supersededBy: { repo: 'ashlrai/phantom', number: 80 } },
      { ...base, id: 'ct_plain', state: 'closed' as const },
    ];
    const prs = backlogRegistrations(tasks, items, []).filter((e) => e.type === 'pr');
    // The closed cloud PR's own state is expected after a supersede; the fleet
    // PR number is what measure/observe/reverts must follow. A carrier the
    // tracker closed or failed is dead work and registers nothing.
    expect(prs).toEqual([
      { type: 'pr', proposalId: backlogProposalId('ct_sup_open'), repository: 'ashlrai/phantom', number: 77 },
      { type: 'pr', proposalId: backlogProposalId('ct_sup_merged'), repository: 'ashlrai/phantom', number: 78 },
    ]);
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

describe('syncCloudBacklogOutcomes', () => {
  const pr = (number: number, state: 'open' | 'merged' | 'closed' = 'open') =>
    ({ number, url: `https://github.com/ashlrai/phantom/pull/${number}`, state, draft: true, title: 't' });
  const stored = (id: string, backlogItemId: string | null, prState: 'open' | 'merged' | 'closed' | null, number = 20) => {
    const now = new Date().toISOString();
    writeCloudTask({ v: 1, id, repo: 'ashlrai/phantom', baseBranch: 'master', branch: `ashlr-cloud/${id}`, title: id, prompt: 'p',
      origin: 'self-improve', requestedBy: 'self-improve', seat: 's', sessionId: null, sessionUrl: null,
      state: prState === 'merged' ? 'merged' : prState === 'closed' ? 'closed' : 'pr-open', stateReason: null, failure: null,
      createdAt: now, launchedAt: now, updatedAt: now, pr: prState ? pr(number, prState) : null, report: null,
      estimatedCostUsd: 1, backlogItemId, needsYouId: null } as unknown as CloudTaskV1);
  };

  it('registers stored metric PRs into the real ledger once, then reports nothing new', () => {
    appendUserBacklogItems([user('m1', 'Perf Gate', 1, { metric }), user('m2', 'Docs')]);
    stored('ct_20261015T0100_aaaaaa', 'm1', 'open', 12);
    stored('ct_20261015T0101_bbbbbb', 'm2', 'open', 13); // item has no metric: never registered
    const first = syncCloudBacklogOutcomes();
    expect(first).toMatchObject({ intact: true, registered: 1, appended: 2 });
    expect(first.reason).toBeUndefined();
    expect(readLedger().records.filter((r) => r.type === 'registered').map((r) => r.proposalId)).toEqual([backlogProposalId('ct_20261015T0100_aaaaaa')]);
    const second = syncCloudBacklogOutcomes();
    expect(second).toMatchObject({ intact: true, registered: 0, appended: 0 });
    expect(second.reason).toBeUndefined();
  });

  it('reports a broken ledger and writes nothing', () => {
    appendUserBacklogItems([user('m1', 'Perf Gate', 1, { metric })]);
    stored('ct_20261015T0100_aaaaaa', 'm1', 'open', 12);
    credit('1111111111', 'Perf Gate', 80);
    fs.appendFileSync(outcomesLedgerPath(), 'not json\n');
    const res = syncCloudBacklogOutcomes();
    expect(res.intact).toBe(false);
    expect(res.reasons.length).toBeGreaterThan(0);
    expect(res).toMatchObject({ registered: 0, appended: 0 });
  });

  it('reports source and append failures instead of throwing', () => {
    const items = [user('m1', 'Perf Gate', 1, { metric })];
    const tasks = [{ id: 'ct_x', repo: 'ashlrai/phantom', title: 'x', backlogItemId: 'm1', pr: pr(9) }] as unknown as CloudTaskV1[];
    expect(syncCloudBacklogOutcomes({ tasks: () => { throw new Error('store down'); } }))
      .toMatchObject({ reason: 'source-unavailable', registered: 0, appended: 0 });
    expect(syncCloudBacklogOutcomes({
      tasks: () => { throw new Error('store down'); },
      ledger: () => ({ records: [], intact: true, reasons: [] }),
    })).toMatchObject({ reason: 'source-unavailable' });
    const failing = syncCloudBacklogOutcomes({
      tasks: () => tasks,
      items: () => items,
      ledger: () => ({ records: [], intact: true, reasons: [] }),
      append: () => { throw new Error('disk full'); },
    });
    expect(failing).toMatchObject({ reason: 'append-failed', registered: 0, appended: 0 });
    const partial: LedgerEvent[] = [];
    let calls = 0;
    const half = syncCloudBacklogOutcomes({
      tasks: () => tasks,
      items: () => items,
      ledger: () => ({ records: [], intact: true, reasons: [] }),
      append: (e) => { calls += 1; if (calls > 1) throw new Error('disk full'); partial.push(e); },
    });
    expect(half).toMatchObject({ reason: 'append-failed', registered: 1, appended: 1 });
    expect(partial.map((e) => e.type)).toEqual(['registered']);
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
