import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_ACTIONS_BACKLOG_MAX_ITEMS,
  AGENT_ACTION_MIN_UNITS,
  agentActionsBacklogItems,
  foldAgentActionEvidence,
  parseAgentActionEntry,
  parseAgentActionPartition,
  type AgentActionRow,
} from '../src/core/improve/agent-actions-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW_MS = Date.parse('2026-12-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let home: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = await mkdtemp(join(tmpdir(), 'improve-agent-actions-'));
  process.env.HOME = home;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

const D1 = '2026-11-28';
const D2 = '2026-11-29';
const D3 = '2026-11-30';

const event = (day: string, hour: number, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schemaVersion: 1,
    ts: `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`,
    actor: 'daemon',
    kind: 'dispatch',
    outcome: 'failed',
    action: 'daemon:dispatch',
    summary: 'daemon:dispatch outcome=failed backend=local-coder source=goal ref=abc123def456',
    reason: 'engine-failed',
    backend: 'local-coder',
    source: 'goal',
    tier: 'mid',
    ...over,
  });

const failedDispatch = (day: string): string => event(day, 8);
const failedEngine = (day: string): string =>
  event(day, 9, { actor: 'agent', kind: 'maintenance', action: 'sandboxed-engine:run', reason: 'failed' });
const unknownTick = (day: string): string =>
  event(day, 10, { kind: 'tick', action: 'daemon:tick', outcome: 'unknown', reason: 'unknown', backend: undefined, source: undefined, tier: undefined });
const okDispatch = (day: string): string => event(day, 11, { outcome: 'ok', reason: 'ok' });
const skippedDispatch = (day: string): string => event(day, 11, { outcome: 'skipped', reason: 'skipped' });
const blockedTick = (day: string): string =>
  event(day, 11, { kind: 'tick', action: 'daemon:tick', outcome: 'blocked', reason: 'pause', backend: undefined, source: undefined, tier: undefined });

/** Three records across three UTC days — past both recurring bars for one cell. */
const recurring = (line: (day: string) => string): string[] => [line(D1), line(D2), line(D3)];

const actionsDirFor = async (name: string, files: Record<string, readonly string[]>): Promise<string> => {
  const dir = join(home, name);
  await mkdir(dir, { recursive: true });
  for (const [file, lines] of Object.entries(files)) {
    await writeFile(join(dir, file), lines.join('\n') + '\n');
  }
  return dir;
};

const row = (day: string, hour: number, over: Partial<AgentActionRow> = {}): AgentActionRow => ({
  atMs: Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`),
  utcDay: day,
  actor: 'daemon',
  kind: 'dispatch',
  action: 'daemon:dispatch',
  outcome: 'failed',
  reason: 'engine-failed',
  backend: 'local-coder',
  source: 'goal',
  tier: 'mid',
  repo: '',
  durationMs: null,
  ...over,
});

describe('parseAgentActionEntry / parseAgentActionPartition', () => {
  it('accepts the writer contract and rejects off-contract rows', () => {
    const parsed = parseAgentActionEntry(JSON.parse(event(D1, 8, { schemaVersion: 2, repo: 'ashlrai/phantom', durationMs: 1234 })));
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      action: 'daemon:dispatch', outcome: 'failed', reason: 'engine-failed',
      backend: 'local-coder', source: 'goal', tier: 'mid', utcDay: D1, durationMs: 1234,
    });
    // Non-adverse outcomes parse — they are valid records, just never evidence.
    expect(parseAgentActionEntry(JSON.parse(okDispatch(D1)))!.outcome).toBe('ok');
    expect(parseAgentActionEntry(JSON.parse(blockedTick(D1)))!.outcome).toBe('blocked');
    // Optional consumed fields may be absent or null.
    const bare = JSON.parse(event(D1, 8));
    delete bare['reason'];
    delete bare['backend'];
    delete bare['source'];
    delete bare['tier'];
    const parsedBare = parseAgentActionEntry(bare);
    expect(parsedBare).not.toBeNull();
    expect(parsedBare).toMatchObject({ reason: '', backend: '', source: '', tier: '' });

    for (const bad of [
      null, 'x', [],
      { ts: 'not-a-date', schemaVersion: 1, actor: 'daemon', kind: 'dispatch', outcome: 'failed', action: 'a:b', summary: 's' },
      { schemaVersion: 3, ts: `${D1}T08:00:00.000Z`, actor: 'daemon', kind: 'dispatch', outcome: 'failed', action: 'a:b', summary: 's' },
      { schemaVersion: 1, ts: `${D1}T08:00:00.000Z`, actor: 'nobody', kind: 'dispatch', outcome: 'failed', action: 'a:b', summary: 's' },
      { schemaVersion: 1, ts: `${D1}T08:00:00.000Z`, actor: 'daemon', kind: 'bogus', outcome: 'failed', action: 'a:b', summary: 's' },
      { schemaVersion: 1, ts: `${D1}T08:00:00.000Z`, actor: 'daemon', kind: 'dispatch', outcome: 'exploded', action: 'a:b', summary: 's' },
      { schemaVersion: 1, ts: `${D1}T08:00:00.000Z`, actor: 'daemon', kind: 'dispatch', outcome: 'failed', action: 'Bad Code', summary: 's' },
      { schemaVersion: 1, ts: `${D1}T08:00:00.000Z`, actor: 'daemon', kind: 'dispatch', outcome: 'failed', action: 'a:b' },
      { schemaVersion: 1, ts: `${D1}T08:00:00.000Z`, actor: 'daemon', kind: 'dispatch', outcome: 'failed', action: 'a:b', summary: 's', backend: 'not-an-engine' },
      { schemaVersion: 1, ts: `${D1}T08:00:00.000Z`, actor: 'daemon', kind: 'dispatch', outcome: 'failed', action: 'a:b', summary: 's', source: 'not-a-source' },
      { schemaVersion: 1, ts: `${D1}T08:00:00.000Z`, actor: 'daemon', kind: 'dispatch', outcome: 'failed', action: 'a:b', summary: 's', tier: 'huge' },
      { schemaVersion: 1, ts: `${D1}T08:00:00.000Z`, actor: 'daemon', kind: 'dispatch', outcome: 'failed', action: 'a:b', summary: 's', repo: 7 },
      { schemaVersion: 1, ts: `${D1}T08:00:00.000Z`, actor: 'daemon', kind: 'dispatch', outcome: 'failed', action: 'a:b', summary: 's', durationMs: 'slow' },
      { schemaVersion: 1, ts: `${D1}T08:00:00.000Z`, actor: 'daemon', kind: 'dispatch', outcome: 'failed', action: 'a:b', summary: 's', durationMs: -5 },
    ]) {
      expect(parseAgentActionEntry(bad)).toBeNull();
    }
  });

  it('counts malformed and off-contract lines without guessing', () => {
    const { rows, invalidRows } = parseAgentActionPartition([
      'not json',
      '{"schemaVersion":1}',
      event(D1, 8),
      '',
      event(D2, 8, { outcome: 'bogus' }),
      event(D3, 8, { backend: 'not-an-engine' }),
    ].join('\n'));
    expect(rows).toHaveLength(1);
    expect(invalidRows).toBe(4);
  });
});

describe('foldAgentActionEvidence', () => {
  it('folds each adverse cell at the recurring bars and ignores hold/lifecycle rows', () => {
    const lines = [
      ...recurring(failedDispatch),
      ...recurring(failedEngine),
      ...recurring(unknownTick),
      // 'ok', 'skipped' and 'blocked' rows — the deliberate-hold and
      // normal-flow vocabulary — never cells.
      ...recurring(okDispatch),
      ...recurring(skippedDispatch),
      ...recurring(blockedTick),
    ];
    const { rows: parsed } = parseAgentActionPartition(lines.join('\n'));
    const folded = foldAgentActionEvidence(parsed, { nowMs: NOW_MS });
    expect(folded.records).toBe(18);
    expect(folded.cells.map((c) => `${c.action}:${c.outcome}`).sort()).toEqual([
      'daemon:dispatch:failed',
      'daemon:tick:unknown',
      'sandboxed-engine:run:failed',
    ]);
    const dispatch = folded.cells.find((c) => c.action === 'daemon:dispatch')!;
    expect(dispatch.units).toBe(AGENT_ACTION_MIN_UNITS);
    expect(dispatch.days.size).toBe(3);
    expect(dispatch.reason).toBe('engine-failed');
    expect(dispatch.backend).toBe('local-coder');
  });

  it('keeps failed and unknown as separate cells for the same action', () => {
    const rows = [
      row(D1, 8), row(D2, 8), row(D3, 8),
      row(D1, 9, { outcome: 'unknown', reason: 'unknown' }),
      row(D2, 9, { outcome: 'unknown', reason: 'unknown' }),
      row(D3, 9, { outcome: 'unknown', reason: 'unknown' }),
    ];
    const folded = foldAgentActionEvidence(rows, { nowMs: NOW_MS });
    expect(folded.cells.map((c) => c.outcome).sort()).toEqual(['failed', 'unknown']);
  });

  it('splits cells on the recorded qualifiers', () => {
    const rows = [
      row(D1, 8), row(D2, 8), row(D3, 8),
      row(D1, 9, { reason: 'sandbox-failed' }), row(D2, 9, { reason: 'sandbox-failed' }), row(D3, 9, { reason: 'sandbox-failed' }),
      row(D1, 10, { backend: 'claude' }), row(D2, 10, { backend: 'claude' }), row(D3, 10, { backend: 'claude' }),
    ];
    const folded = foldAgentActionEvidence(rows, { nowMs: NOW_MS });
    expect(folded.cells).toHaveLength(3);
  });

  it('stays quiet below the recurring bars and outside the window', () => {
    // Three failures on ONE UTC day only.
    const oneDay = foldAgentActionEvidence(
      [row('2026-11-30', 8), row('2026-11-30', 9), row('2026-11-30', 10)],
      { nowMs: NOW_MS },
    );
    expect(oneDay.cells).toEqual([]);

    // Two records across two days — under the units bar.
    const two = foldAgentActionEvidence([row(D1, 8), row(D2, 8)], { nowMs: NOW_MS });
    expect(two.cells).toEqual([]);

    // Records outside the 14-day window never count.
    const ancient = foldAgentActionEvidence(
      [row('2026-11-10', 8), row('2026-11-11', 8), row('2026-11-12', 8), row('2026-11-13', 8)],
      { nowMs: NOW_MS },
    );
    expect(ancient.records).toBe(0);
    expect(ancient.outsideWindow).toBe(4);
    expect(ancient.cells).toEqual([]);
  });
});

describe('agentActionsBacklogItems', () => {
  it('emits one item per recurring cell with stable ids, prompts and metadata', async () => {
    const dir = await actionsDirFor('actions-all', {
      [`${D1}.jsonl`]: [failedDispatch(D1), failedEngine(D1), unknownTick(D1), okDispatch(D1)],
      [`${D2}.jsonl`]: [failedDispatch(D2), failedEngine(D2), unknownTick(D2)],
      [`${D3}.jsonl`]: [failedDispatch(D3), failedEngine(D3), unknownTick(D3)],
      // Partitions outside the window and non-partition names are ignored.
      'notes.txt': ['ignored'],
      '2026-10-01.jsonl': [failedDispatch('2026-10-01'), failedDispatch('2026-10-01'), failedDispatch('2026-10-01')],
    });
    const items = await agentActionsBacklogItems({ repo: 'ashlrai/phantom', agentActionsDirPath: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.priority === 3 && i.area === 'agent-actions' && i.repo === 'ashlrai/phantom')).toBe(true);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
    expect(items.every((i) => i.id.startsWith('agent-actions-') && i.id.length <= 120)).toBe(true);

    const dispatch = items.find((i) => i.prompt.includes("'daemon:dispatch'"))!;
    const engine = items.find((i) => i.prompt.includes('sandboxed-engine:run'))!;
    const tick = items.find((i) => i.prompt.includes("'daemon:tick'"))!;
    expect(dispatch.title).toContain('daemon:dispatch');
    expect(dispatch.title).toContain('failed');
    expect(dispatch.prompt).toContain('engine-failed');
    expect(dispatch.prompt).toContain('local-coder');
    expect(dispatch.prompt).toContain('agent-actions');
    expect(dispatch.prompt).toContain('no-change');
    expect(engine.prompt).toContain('sandboxed-engine:run');
    expect(tick.prompt).toContain('could not classify');
    expect(tick.prompt).toContain('tickAgentOutcome');
  });

  it('emits nothing below the bars, on missing dirs, or for another repository', async () => {
    // Below the units bar: two records across two days.
    const few = await actionsDirFor('actions-few', {
      [`${D1}.jsonl`]: [failedDispatch(D1)],
      [`${D2}.jsonl`]: [failedDispatch(D2)],
    });
    expect(await agentActionsBacklogItems({ repo: 'ashlrai/phantom', agentActionsDirPath: few, now: new Date(NOW_MS) })).toEqual([]);

    // Below the days bar: three records on one UTC day.
    const oneDay = await actionsDirFor('actions-oneday', {
      [`${D3}.jsonl`]: [failedDispatch(D3), failedDispatch(D3), failedDispatch(D3)],
    });
    expect(await agentActionsBacklogItems({ repo: 'ashlrai/phantom', agentActionsDirPath: oneDay, now: new Date(NOW_MS) })).toEqual([]);

    // Only hold/lifecycle rows: never evidence.
    const holds = await actionsDirFor('actions-holds', {
      [`${D1}.jsonl`]: [okDispatch(D1), skippedDispatch(D1), blockedTick(D1)],
      [`${D2}.jsonl`]: [okDispatch(D2), skippedDispatch(D2), blockedTick(D2)],
      [`${D3}.jsonl`]: [okDispatch(D3), skippedDispatch(D3), blockedTick(D3)],
    });
    expect(await agentActionsBacklogItems({ repo: 'ashlrai/phantom', agentActionsDirPath: holds, now: new Date(NOW_MS) })).toEqual([]);

    // Missing dir, empty dir, and a file where the dir should be.
    expect(await agentActionsBacklogItems({ repo: 'ashlrai/phantom', agentActionsDirPath: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);
    const empty = await actionsDirFor('actions-empty', {});
    expect(await agentActionsBacklogItems({ repo: 'ashlrai/phantom', agentActionsDirPath: empty, now: new Date(NOW_MS) })).toEqual([]);
    const file = join(home, 'actions-file');
    await writeFile(file, 'x');
    expect(await agentActionsBacklogItems({ repo: 'ashlrai/phantom', agentActionsDirPath: file, now: new Date(NOW_MS) })).toEqual([]);

    // Garbage partitions are not evidence.
    const junk = await actionsDirFor('actions-junk', { [`${D1}.jsonl`]: ['not json', '{"schemaVersion":1}'], [`${D2}.jsonl`]: ['also not json'] });
    expect(await agentActionsBacklogItems({ repo: 'ashlrai/phantom', agentActionsDirPath: junk, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this install's evidence.
    const dir = await actionsDirFor('actions-repo', {
      [`${D1}.jsonl`]: [failedDispatch(D1)],
      [`${D2}.jsonl`]: [failedDispatch(D2)],
      [`${D3}.jsonl`]: [failedDispatch(D3)],
    });
    expect(await agentActionsBacklogItems({ repo: 'ashlrai/other', agentActionsDirPath: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await agentActionsBacklogItems({ repo: 'AshlrAI/Phantom', agentActionsDirPath: dir, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('reads the writer-resolved agent-actions dir under the relocated home when no override is given', async () => {
    // agentActionsDir() resolves $ASHLR_HOME ?? ~/.ashlr — the worker's
    // relocated HOME under Vitest — so fixtures land beside it.
    const dir = join(home, '.ashlr', 'agent-actions');
    await mkdir(dir, { recursive: true });
    for (const d of [D1, D2, D3]) {
      await writeFile(join(dir, `${d}.jsonl`), [failedDispatch(d)].join('\n') + '\n');
    }
    const items = await agentActionsBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('daemon:dispatch');
  });

  it('honours the item limit and derives stable ids across calls', async () => {
    const dir = await actionsDirFor('actions-stable', {
      [`${D1}.jsonl`]: [failedDispatch(D1), failedEngine(D1), unknownTick(D1)],
      [`${D2}.jsonl`]: [failedDispatch(D2), failedEngine(D2), unknownTick(D2)],
      [`${D3}.jsonl`]: [failedDispatch(D3), failedEngine(D3), unknownTick(D3)],
    });
    const opts = { repo: 'ashlrai/phantom', agentActionsDirPath: dir, now: new Date(NOW_MS) };
    const first = await agentActionsBacklogItems(opts);
    const second = await agentActionsBacklogItems(opts);
    expect(first).toHaveLength(3);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const limited = await agentActionsBacklogItems({ ...opts, limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.length).toBeLessThanOrEqual(Math.min(AGENT_ACTIONS_BACKLOG_MAX_ITEMS, 25));
  });

  it('states truncated partition tails as lower bounds', async () => {
    // >4 MiB of retained rows in one partition: the bounded tail drops
    // the oldest bytes, so every count is a lower bound. Padding the
    // summary field keeps the fixture small in row count.
    const pad = 'x'.repeat(400);
    const filler: string[] = [];
    for (let i = 0; i < 11000; i += 1) {
      filler.push(event(D1, i % 24, { action: `daemon:pad-${i % 50}`, outcome: i % 7 === 0 ? 'failed' : 'ok', summary: `pad-${i}-${pad}` }));
    }
    const dir = await actionsDirFor('actions-big', {
      // The recurring cell's D1 row sits at the file's tail so the
      // bounded read retains it while dropping the oldest filler.
      [`${D1}.jsonl`]: [...filler, failedDispatch(D1)],
      [`${D2}.jsonl`]: [failedDispatch(D2)],
      [`${D3}.jsonl`]: [failedDispatch(D3)],
    });
    const items = await agentActionsBacklogItems({ repo: 'ashlrai/phantom', agentActionsDirPath: dir, now: new Date(NOW_MS) });
    const dispatch = items.find((i) => i.prompt.includes("'daemon:dispatch'"));
    expect(dispatch).toBeDefined();
    expect(dispatch!.prompt).toContain('lower bound');
  }, 60_000);

  it('scrubs secret-shaped text out of journal strings before it reaches a prompt', async () => {
    const token = '123456789:AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHJ';
    const dir = await actionsDirFor('actions-secret', {
      [`${D1}.jsonl`]: [event(D1, 8, { reason: `engine-failed ${token}` })],
      [`${D2}.jsonl`]: [event(D2, 8, { reason: `engine-failed ${token}` })],
      [`${D3}.jsonl`]: [event(D3, 8, { reason: `engine-failed ${token}` })],
    });
    const items = await agentActionsBacklogItems({ repo: 'ashlrai/phantom', agentActionsDirPath: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('[REDACTED]');
  });

  it('appends agent-action items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the evidence window on the wall clock, so
    // the fixtures use days relative to real now — three distinct UTC
    // days inside the window, like the fixed-date fixtures above.
    const dayAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
    const failed = (iso: string): string => JSON.stringify({
      schemaVersion: 1, ts: iso, actor: 'daemon', kind: 'dispatch', outcome: 'failed',
      action: 'daemon:dispatch', summary: 'daemon:dispatch outcome=failed backend=local-coder source=goal ref=abc123def456',
      reason: 'engine-failed', backend: 'local-coder', source: 'goal', tier: 'mid',
    });
    const unknown = (iso: string): string => JSON.stringify({
      schemaVersion: 1, ts: iso, actor: 'daemon', kind: 'tick', outcome: 'unknown',
      action: 'daemon:tick', summary: 'daemon:tick outcome=unknown ref=abc123def456',
      reason: 'unknown',
    });
    const dir = join(home, '.ashlr', 'agent-actions');
    await mkdir(dir, { recursive: true });
    for (const d of [1, 2, 3]) {
      const iso = `${dayAgo(d)}T08:00:00.000Z`;
      await writeFile(join(dir, `${dayAgo(d)}.jsonl`), [failed(iso), unknown(iso)].join('\n') + '\n');
    }
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const actionItems = first.items.filter((i) => i.id.startsWith('agent-actions-'));
    expect(actionItems).toHaveLength(2);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(actionItems)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('agent-actions-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('agent-actions-'))).toHaveLength(2);
  });
});
