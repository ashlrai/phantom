import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GATEWAY_ACTIVITY_BACKLOG_MAX_ITEMS,
  GATEWAY_ACTIVITY_MIN_UNITS,
  GATEWAY_ACTIVITY_TAIL_BYTES,
  foldGatewayActivityEvidence,
  gatewayActivityBacklogItems,
  parseGatewayActivityEntry,
  parseGatewayActivityText,
  type GatewayActivityRow,
} from '../src/core/improve/gateway-activity-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW_MS = Date.parse('2026-12-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let home: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_RUNS_DIR;
  home = await mkdtemp(join(tmpdir(), 'improve-gwactivity-'));
  process.env.HOME = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

const D1 = '2026-11-28';
const D2 = '2026-11-29';
const D3 = '2026-11-30';

const SESSION = 'gs_0123456789ab';

const entry = (day: string, hour: number, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ts: `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`,
    session: SESSION,
    caller: 'claude',
    tool: 'ashlr__fleet_status',
    verdict: 'deny',
    args: { filter: '[redacted]', limit: '[redacted]' },
    ...over,
  });

const denyStatus = (day: string, over: Record<string, unknown> = {}): string => entry(day, 8, over);
const gatedReview = (day: string): string =>
  entry(day, 9, { tool: 'ashlr__pr_merge', verdict: 'approval_required', args: { pr: '[redacted]' } });
const revokedCall = (day: string): string =>
  entry(day, 10, { tool: 'context7__query_docs', verdict: 'revoked', args: {} });
const allowCall = (day: string): string => entry(day, 11, { verdict: 'allow' });

/** Three records across three UTC days — past both recurring bars for one cell. */
const recurring = (line: (day: string) => string): string[] => [line(D1), line(D2), line(D3)];

const journalFile = async (name: string, lines: readonly string[]): Promise<string> => {
  const dir = join(home, name);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'activity.jsonl');
  await writeFile(file, lines.join('\n') + '\n');
  return file;
};

const row = (day: string, hour: number, over: Partial<GatewayActivityRow> = {}): GatewayActivityRow => ({
  atMs: Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`),
  utcDay: day,
  caller: 'claude',
  tool: 'ashlr__fleet_status',
  verdict: 'deny',
  argKeys: ['filter', 'limit'],
  ...over,
});

describe('parseGatewayActivityEntry / parseGatewayActivityText', () => {
  it('accepts the writer contract and rejects off-contract rows', () => {
    const parsed = parseGatewayActivityEntry(JSON.parse(entry(D1, 8)));
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({ caller: 'claude', tool: 'ashlr__fleet_status', verdict: 'deny', utcDay: D1 });
    expect(parsed!.argKeys).toEqual(['filter', 'limit']);
    // 'allow' rows parse — they are valid records, just never evidence.
    expect(parseGatewayActivityEntry(JSON.parse(allowCall(D1)))!.verdict).toBe('allow');
    // args may be the empty object the writer emits for non-object input.
    expect(parseGatewayActivityEntry(JSON.parse(revokedCall(D1)))!.argKeys).toEqual([]);

    for (const bad of [
      null, 'x', [],
      { ts: 'not-a-date', session: SESSION, caller: 'c', tool: 't', verdict: 'deny', args: {} },
      { ts: `${D1}T08:00:00.000Z`, session: 'gs_short', caller: 'c', tool: 't', verdict: 'deny', args: {} },
      { ts: `${D1}T08:00:00.000Z`, session: 'xx_0123456789ab', caller: 'c', tool: 't', verdict: 'deny', args: {} },
      { ts: `${D1}T08:00:00.000Z`, session: SESSION, caller: '', tool: 't', verdict: 'deny', args: {} },
      { ts: `${D1}T08:00:00.000Z`, session: SESSION, caller: 'c'.repeat(81), tool: 't', verdict: 'deny', args: {} },
      { ts: `${D1}T08:00:00.000Z`, session: SESSION, caller: 'c', tool: '', verdict: 'deny', args: {} },
      { ts: `${D1}T08:00:00.000Z`, session: SESSION, caller: 'c', tool: 't'.repeat(161), verdict: 'deny', args: {} },
      { ts: `${D1}T08:00:00.000Z`, session: SESSION, caller: 'c', tool: 't', verdict: 'maybe', args: {} },
      { ts: `${D1}T08:00:00.000Z`, session: SESSION, caller: 'c', tool: 't', verdict: 'deny' },
      { ts: `${D1}T08:00:00.000Z`, session: SESSION, caller: 'c', tool: 't', verdict: 'deny', args: [] },
      { ts: `${D1}T08:00:00.000Z`, session: SESSION, caller: 'c', tool: 't', verdict: 'deny', args: { a: 'real-value' } },
      { ts: `${D1}T08:00:00.000Z`, session: SESSION, caller: 'c', tool: 't', verdict: 'deny', args: { ['k'.repeat(41)]: '[redacted]' } },
      { ts: `${D1}T08:00:00.000Z`, session: SESSION, caller: 'c', tool: 't', verdict: 'deny',
        args: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, '[redacted]'])) },
    ]) {
      expect(parseGatewayActivityEntry(bad)).toBeNull();
    }
  });

  it('counts malformed and off-contract lines without guessing', () => {
    const { rows, invalidRows } = parseGatewayActivityText([
      'not json',
      '{"ts":"2026-11-28T08:00:00.000Z"}',
      entry(D1, 8),
      '',
      entry(D2, 8, { verdict: 'bogus' }),
    ].join('\n'));
    expect(rows).toHaveLength(1);
    expect(invalidRows).toBe(3);
  });
});

describe('foldGatewayActivityEvidence', () => {
  it('folds each adverse cell at the recurring bars and ignores allow rows', () => {
    const lines = [
      ...recurring(denyStatus),
      ...recurring(gatedReview),
      ...recurring(revokedCall),
      // 'allow' rows — the call running — never cells.
      ...recurring(allowCall),
    ];
    const { rows: parsed } = parseGatewayActivityText(lines.join('\n'));
    const folded = foldGatewayActivityEvidence(parsed, { nowMs: NOW_MS });
    expect(folded.records).toBe(12);
    expect(folded.cells.map((c) => `${c.caller}:${c.tool}:${c.kind}`).sort()).toEqual([
      'claude:ashlr__fleet_status:deny',
      'claude:ashlr__pr_merge:approval_required',
      'claude:context7__query_docs:revoked',
    ]);
    const deny = folded.cells.find((c) => c.kind === 'deny')!;
    expect(deny.units).toBe(GATEWAY_ACTIVITY_MIN_UNITS);
    expect(deny.days.size).toBe(3);
    expect(deny.samples).toEqual(['filter, limit']);
  });

  it('keeps caller, tool and verdict as separate cell dimensions', () => {
    const rows = [
      // Same tool+verdict, different callers — two cells.
      ...recurring((d) => row(d, 8)),
      ...recurring((d) => row(d, 8, { caller: 'codex' })),
      // Same caller+tool, different verdicts — separate cells.
      ...recurring((d) => row(d, 9, { verdict: 'approval_required' })),
    ];
    const folded = foldGatewayActivityEvidence(rows, { nowMs: NOW_MS });
    expect(folded.cells).toHaveLength(3);
    expect(new Set(folded.cells.map((c) => c.kind))).toEqual(new Set(['deny', 'approval_required']));
    expect(folded.cells.filter((c) => c.kind === 'deny').map((c) => c.caller).sort()).toEqual(['claude', 'codex']);
  });

  it('stays quiet below the recurring bars and outside the window', () => {
    // Three denials on ONE UTC day only.
    const oneDay = foldGatewayActivityEvidence(
      [row('2026-11-30', 8), row('2026-11-30', 9), row('2026-11-30', 10)],
      { nowMs: NOW_MS },
    );
    expect(oneDay.cells).toEqual([]);

    // Two records across two days — under the units bar.
    const two = foldGatewayActivityEvidence([row(D1, 8), row(D2, 8)], { nowMs: NOW_MS });
    expect(two.cells).toEqual([]);

    // Old records outside the 7-day window never count.
    const ancient = foldGatewayActivityEvidence(
      [row('2026-11-10', 8), row('2026-11-11', 8), row('2026-11-12', 8), row('2026-11-13', 8)],
      { nowMs: NOW_MS },
    );
    expect(ancient.records).toBe(0);
    expect(ancient.outsideWindow).toBe(4);
    expect(ancient.cells).toEqual([]);
  });
});

describe('gatewayActivityBacklogItems', () => {
  it('emits one item per recurring cell with stable ids, prompts and metadata', async () => {
    const file = await journalFile('gw-all', [
      ...recurring(denyStatus),
      ...recurring(gatedReview),
      ...recurring(revokedCall),
      ...recurring(allowCall),
    ]);
    const items = await gatewayActivityBacklogItems({ repo: 'ashlrai/phantom', activityPath: file, now: new Date(NOW_MS) });
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.priority === 3 && i.area === 'mcp-gateway' && i.repo === 'ashlrai/phantom')).toBe(true);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
    expect(items.every((i) => i.id.startsWith('gateway-activity-') && i.id.length <= 120)).toBe(true);

    const denied = items.find((i) => i.prompt.includes('ashlr__fleet_status'))!;
    const gated = items.find((i) => i.prompt.includes('ashlr__pr_merge'))!;
    const revoked = items.find((i) => i.prompt.includes('context7__query_docs'))!;
    expect(denied.title).toContain('ashlr__fleet_status');
    expect(denied.title).toContain('claude');
    expect(denied.prompt).toContain('ashlr__fleet_status');
    expect(denied.prompt).toContain('filter, limit');
    expect(denied.prompt).toContain('gateway/activity.jsonl');
    expect(denied.prompt).toContain('no-change');
    expect(gated.prompt).toContain('ashlr__pr_merge');
    expect(gated.prompt).toContain('approval_required');
    expect(revoked.prompt).toContain('context7__query_docs');
    expect(revoked.prompt).toContain('revoked');
  });

  it('emits nothing below the bars, on missing files, or for another repository', async () => {
    // Below the units bar: two records across two days.
    const few = await journalFile('gw-few', [entry(D1, 8), entry(D2, 8)]);
    expect(await gatewayActivityBacklogItems({ repo: 'ashlrai/phantom', activityPath: few, now: new Date(NOW_MS) })).toEqual([]);

    // Below the days bar: three records on one UTC day.
    const oneDay = await journalFile('gw-oneday', [entry(D3, 8), entry(D3, 9), entry(D3, 10)]);
    expect(await gatewayActivityBacklogItems({ repo: 'ashlrai/phantom', activityPath: oneDay, now: new Date(NOW_MS) })).toEqual([]);

    // Missing file, a directory where the file should be, and garbage rows.
    expect(await gatewayActivityBacklogItems({ repo: 'ashlrai/phantom', activityPath: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);
    const dirAsFile = join(home, 'gw-dir');
    await mkdir(dirAsFile, { recursive: true });
    expect(await gatewayActivityBacklogItems({ repo: 'ashlrai/phantom', activityPath: dirAsFile, now: new Date(NOW_MS) })).toEqual([]);
    const junk = await journalFile('gw-junk', ['not json', '{"ts":"x"}', entry(D1, 8, { verdict: 'bogus' })]);
    expect(await gatewayActivityBacklogItems({ repo: 'ashlrai/phantom', activityPath: junk, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this install's evidence.
    const file = await journalFile('gw-repo', recurring(denyStatus));
    expect(await gatewayActivityBacklogItems({ repo: 'ashlrai/other', activityPath: file, now: new Date(NOW_MS) })).toEqual([]);
    expect(await gatewayActivityBacklogItems({ repo: 'AshlrAI/Phantom', activityPath: file, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('reads the writer-resolved activityLogPath under the relocated home when no override is given', async () => {
    // activityLogPath() resolves ashlrHome()/gateway/activity.jsonl —
    // $ASHLR_HOME when absolute — so fixtures land beside the test home.
    const dir = join(home, '.ashlr', 'gateway');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'activity.jsonl'), recurring(denyStatus).join('\n') + '\n');
    const items = await gatewayActivityBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('ashlr__fleet_status');
  });

  it('honours the item limit and derives stable ids across calls', async () => {
    const file = await journalFile('gw-stable', [
      ...recurring(denyStatus),
      ...recurring(gatedReview),
      ...recurring(revokedCall),
    ]);
    const opts = { repo: 'ashlrai/phantom', activityPath: file, now: new Date(NOW_MS) };
    const first = await gatewayActivityBacklogItems(opts);
    const second = await gatewayActivityBacklogItems(opts);
    expect(first).toHaveLength(3);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const limited = await gatewayActivityBacklogItems({ ...opts, limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.length).toBeLessThanOrEqual(Math.min(GATEWAY_ACTIVITY_BACKLOG_MAX_ITEMS, 25));
  });

  it('states a truncated tail as a lower bound', async () => {
    // One oversized first line pushes the file past the bounded tail:
    // readLedgerTail keeps only whole trailing lines and flags truncation.
    const pad = 'x'.repeat(GATEWAY_ACTIVITY_TAIL_BYTES);
    const file = await journalFile('gw-big', []);
    await writeFile(file, `${pad}\n${recurring(denyStatus).join('\n')}\n`);
    const items = await gatewayActivityBacklogItems({ repo: 'ashlrai/phantom', activityPath: file, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  }, 30_000);

  it('scrubs secret-shaped text out of journal strings before it reaches a prompt', async () => {
    const token = '123456789:AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHJ';
    const file = await journalFile('gw-secret', recurring((d) => entry(d, 8, { tool: token })));
    const items = await gatewayActivityBacklogItems({ repo: 'ashlrai/phantom', activityPath: file, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.title).not.toContain(token);
  });

  it('appends gateway-activity items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the evidence window on the wall clock, so
    // the fixtures use days relative to real now — three distinct UTC
    // days inside the window, like the fixed-date fixtures above.
    const dayAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
    const denied = (iso: string): string => JSON.stringify({ ts: iso, session: SESSION, caller: 'claude', tool: 'ashlr__fleet_status', verdict: 'deny', args: {} });
    const gated = (iso: string): string => JSON.stringify({ ts: iso, session: SESSION, caller: 'claude', tool: 'ashlr__pr_merge', verdict: 'approval_required', args: {} });
    const dir = join(home, '.ashlr', 'gateway');
    await mkdir(dir, { recursive: true });
    for (const d of [1, 2, 3]) {
      const day = dayAgo(d);
      await writeFile(join(dir, 'activity.jsonl'),
        [denied(`${day}T08:00:00.000Z`), gated(`${day}T09:00:00.000Z`)].join('\n') + '\n',
        { flag: d === 1 ? 'w' : 'a' });
    }
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const gwItems = first.items.filter((i) => i.id.startsWith('gateway-activity-'));
    expect(gwItems).toHaveLength(2);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(gwItems)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('gateway-activity-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('gateway-activity-'))).toHaveLength(2);
  });
});
