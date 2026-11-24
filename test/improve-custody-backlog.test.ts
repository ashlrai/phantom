import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTODY_BACKLOG_MAX_ITEMS,
  CUSTODY_MIN_UNITS,
  custodyBacklogItems,
  foldCustodyEvidence,
  parseCustodyJournal,
  parseCustodyRecord,
} from '../src/core/improve/custody-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import { CUSTODY_LEDGER_MAX_BYTES } from '../src/core/run/custody-ledger.js';

const NOW_MS = Date.parse('2026-12-01T12:00:00.000Z');
const LEDGER = join('.ashlr', 'custody', 'spawns.jsonl');
const DAY_MS = 24 * 60 * 60 * 1000;

let home: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
  delete process.env.ASHLR_HOME;
  home = await mkdtemp(join(tmpdir(), 'improve-custody-'));
  process.env.HOME = home;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

/** One writer-contract unwrapped row (reason present, preflight_exit may be null). */
const unwrapped = (at: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: 1,
    at,
    wrapped: false,
    reason: 'worktree-namespace',
    engine: 'claude',
    preflight_exit: null,
    ...over,
  });

/** One writer-contract wrapped row: no reason key, exit code carried. */
const wrapped = (at: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ schema: 1, at, wrapped: true, engine: 'codex', preflight_exit: 0, ...over });

const at = (day: string, hour = 8): string => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const D1 = '2026-11-28';
const D2 = '2026-11-29';
const D3 = '2026-11-30';

/** Three records across three UTC days — past both recurring bars for one cell. */
const recurring = (line: (day: string) => string): string[] => [line(D1), line(D2), line(D3)];

const worktree = (day: string): string => unwrapped(at(day));
const preflightBlocked = (day: string): string => unwrapped(at(day), { reason: 'preflight-blocked', preflight_exit: 1, engine: 'codex' });
const phantomMissing = (day: string): string => unwrapped(at(day), { reason: 'phantom-not-installed', engine: 'cursor-agent' });
const foreignReason = (day: string): string => unwrapped(at(day), { reason: 'a-reason-this-build-never-wrote' });
const disabled = (day: string): string => unwrapped(at(day), { reason: 'phantom-disabled' });
const selfAuth = (day: string): string => unwrapped(at(day), { reason: 'self-authenticating-engine' });

const custodyDir = async (name: string, current: readonly string[], previous: readonly string[] = []): Promise<string> => {
  const dir = join(home, name);
  await mkdir(join(dir, '.ashlr', 'custody'), { recursive: true });
  await writeFile(join(dir, LEDGER), current.join('\n') + (current.length ? '\n' : ''));
  if (previous.length) await writeFile(join(dir, `${LEDGER}.1`), previous.join('\n') + '\n');
  return dir;
};

describe('parseCustodyRecord / parseCustodyJournal', () => {
  it('accepts the writer contract and normalizes like the writer\'s own readers', () => {
    const parsed = parseCustodyRecord(JSON.parse(unwrapped(at(D1), { reason: 'preflight-blocked', preflight_exit: 2 })));
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({ wrapped: false, reason: 'preflight-blocked', engine: 'claude', preflightExit: 2, utcDay: D1 });

    const ok = parseCustodyRecord(JSON.parse(wrapped(at(D1))));
    expect(ok).toMatchObject({ wrapped: true, reason: null, engine: 'codex', preflightExit: 0 });

    // Foreign reason values normalize to 'unknown' on unwrapped rows —
    // the writer reader's own rule — while a wrapped row ignores a stray
    // reason key entirely.
    expect(parseCustodyRecord(JSON.parse(unwrapped(at(D1), { reason: 'bogus' })))!.reason).toBe('unknown');
    expect(parseCustodyRecord(JSON.parse(unwrapped(at(D1), { reason: undefined })))!.reason).toBe('unknown');
    const stray = JSON.parse(wrapped(at(D1)));
    stray['reason'] = 'worktree-namespace';
    const strayParsed = parseCustodyRecord(stray);
    expect(strayParsed!.wrapped).toBe(true);
    expect(strayParsed!.reason).toBeNull();

    // Engine shape follows the writer's ENGINE_SHAPE rule: off-shape
    // values read as 'unknown', never reach a prompt raw.
    expect(parseCustodyRecord(JSON.parse(unwrapped(at(D1), { engine: 'claude' })))!.engine).toBe('claude');
    expect(parseCustodyRecord(JSON.parse(unwrapped(at(D1), { engine: 'has space' })))!.engine).toBe('unknown');
    expect(parseCustodyRecord(JSON.parse(unwrapped(at(D1), { engine: 42 })))!.engine).toBe('unknown');

    // preflight_exit is context: safeExit-shaped values keep, anything
    // else degrades to null without costing the record.
    expect(parseCustodyRecord(JSON.parse(unwrapped(at(D1), { preflight_exit: 255 })))!.preflightExit).toBe(255);
    expect(parseCustodyRecord(JSON.parse(unwrapped(at(D1), { preflight_exit: -1 })))!.preflightExit).toBe(-1);
    expect(parseCustodyRecord(JSON.parse(unwrapped(at(D1), { preflight_exit: 300 })))!.preflightExit).toBeNull();
    expect(parseCustodyRecord(JSON.parse(unwrapped(at(D1), { preflight_exit: 'x' })))!.preflightExit).toBeNull();

    // Whole-row contract violations reject the record.
    for (const bad of [
      null, 'x', [],
      { ...JSON.parse(unwrapped(at(D1))), schema: 2 },
      { ...JSON.parse(unwrapped(at(D1))), schema: '1' },
      { ...JSON.parse(unwrapped(at(D1))), at: 'not-a-date' },
      { ...JSON.parse(unwrapped(at(D1))), at: 1767000000000 },
      { ...JSON.parse(unwrapped(at(D1))), wrapped: 'yes' },
      { ...JSON.parse(unwrapped(at(D1))), wrapped: 1 },
    ]) {
      expect(parseCustodyRecord(bad)).toBeNull();
    }
  });

  it('counts malformed and off-contract lines without guessing', () => {
    const { records, invalidRows } = parseCustodyJournal([
      'not json',
      '{"schema":1,"at":"2026-11-28T08:00:00.000Z"}',
      unwrapped(at(D1)),
      '',
      unwrapped(at(D2), { wrapped: 'bogus' }),
    ].join('\n'));
    expect(records).toHaveLength(1);
    expect(invalidRows).toBe(3);
  });
});

describe('foldCustodyEvidence', () => {
  const recordsOf = (lines: readonly string[]) => parseCustodyJournal(lines.join('\n')).records;

  it('folds each adverse reason at the recurring bars and ignores deliberate states', () => {
    const lines = [
      ...recurring(worktree),
      ...recurring(preflightBlocked),
      ...recurring(phantomMissing),
      ...recurring(foreignReason),
      // Deliberate states and the machinery working: never cells.
      ...recurring(disabled),
      ...recurring(selfAuth),
      ...recurring((d) => wrapped(at(d))),
    ];
    const folded = foldCustodyEvidence(recordsOf(lines), { nowMs: NOW_MS });
    expect(folded.records).toBe(21);
    expect(folded.wrapped).toBe(3);
    expect(folded.cells.map((c) => c.reason).sort()).toEqual([
      'phantom-not-installed',
      'preflight-blocked',
      'unknown',
      'worktree-namespace',
    ]);
    const cell = folded.cells.find((c) => c.reason === 'worktree-namespace')!;
    expect(cell.units).toBe(CUSTODY_MIN_UNITS);
    expect(cell.days.size).toBe(3);
    expect(cell.engines.get('claude')).toBe(3);
    expect(cell.preflightExits.has(null)).toBe(true);
    const blocked = folded.cells.find((c) => c.reason === 'preflight-blocked')!;
    expect(blocked.engines.get('codex')).toBe(3);
    expect(blocked.preflightExits.has(1)).toBe(true);
  });

  it('stays quiet below the recurring bars and outside the window', () => {
    // Three records on ONE UTC day only.
    const oneDay = foldCustodyEvidence(recordsOf([
      worktree('2026-11-30'), worktree('2026-11-30'), worktree('2026-11-30'),
    ]), { nowMs: NOW_MS });
    expect(oneDay.cells).toEqual([]);

    // Two records across two days — under the units bar.
    const two = foldCustodyEvidence(recordsOf([worktree(D1), worktree(D2)]), { nowMs: NOW_MS });
    expect(two.cells).toEqual([]);

    // Records outside the 7-day window never count.
    const ancient = foldCustodyEvidence(recordsOf([
      unwrapped(at('2026-11-01')), unwrapped(at('2026-11-02')), unwrapped(at('2026-11-03')),
      wrapped(at('2026-11-04')),
    ]), { nowMs: NOW_MS });
    expect(ancient.records).toBe(0);
    expect(ancient.outsideWindow).toBe(4);
    expect(ancient.cells).toEqual([]);
  });
});

describe('custodyBacklogItems', () => {
  it('emits one item per recurring reason with stable ids, prompts and metadata', async () => {
    const lines = [
      ...recurring(worktree),
      ...recurring(preflightBlocked),
      ...recurring(phantomMissing),
      ...recurring(disabled),
      wrapped(at(D1)), wrapped(at(D2)), wrapped(at(D3)),
    ];
    const dir = await custodyDir('home-items', lines);
    const items = await custodyBacklogItems({ repo: 'ashlrai/phantom', homeDir: dir, now: new Date(NOW_MS) });
    expect(items.map((i) => i.id).sort()).toEqual([
      'custody-phantom-not-installed',
      'custody-preflight-blocked',
      'custody-worktree-namespace',
    ]);
    expect(items.every((i) => i.priority === 3 && i.area === 'fleet-custody' && i.repo === 'ashlrai/phantom')).toBe(true);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);

    const worktreeItem = items.find((i) => i.id === 'custody-worktree-namespace')!;
    expect(worktreeItem.title).toContain('worktree');
    expect(worktreeItem.prompt).toContain('spawns.jsonl');
    expect(worktreeItem.prompt).toContain('worktree-namespace');
    expect(worktreeItem.prompt).toContain('3 in-window unwrapped records across 3 UTC days');
    expect(worktreeItem.prompt).toContain('claude×3');
    expect(worktreeItem.prompt).toContain('15 in-window spawns, 3 wrapped');
    expect(worktreeItem.prompt).toContain('phantom-disabled');

    const blocked = items.find((i) => i.id === 'custody-preflight-blocked')!;
    expect(blocked.prompt).toContain('preflight-blocked');
    expect(blocked.prompt).toContain('codex×3');
    expect(blocked.prompt).toContain('Preflight exits seen: 1');

    const missing = items.find((i) => i.id === 'custody-phantom-not-installed')!;
    expect(missing.prompt).toContain('phantom-not-installed');
    expect(missing.prompt).toContain('cursor-agent×3');

    // Deterministic cap respected.
    expect(items.length).toBeLessThanOrEqual(Math.min(CUSTODY_BACKLOG_MAX_ITEMS, 25));
    const limited = await custodyBacklogItems({ repo: 'ashlrai/phantom', homeDir: dir, now: new Date(NOW_MS), limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it('reads the rotated .1 predecessor so a rotation never hides recurrence', async () => {
    // Two records in the rotated predecessor, one in the live file —
    // three distinct days across the generation boundary.
    const dir = await custodyDir('home-rotated', [worktree(D3)], [worktree(D1), worktree(D2)]);
    const items = await custodyBacklogItems({ repo: 'ashlrai/phantom', homeDir: dir, now: new Date(NOW_MS) });
    expect(items.map((i) => i.id)).toEqual(['custody-worktree-namespace']);
    expect(items[0]!.prompt).toContain('3 in-window unwrapped records');
  });

  it('emits nothing below the bars, on missing or unreadable ledgers, or for another repository', async () => {
    // Below the units bar: two records across two days.
    const few = await custodyDir('home-few', [worktree(D1), worktree(D2)]);
    expect(await custodyBacklogItems({ repo: 'ashlrai/phantom', homeDir: few, now: new Date(NOW_MS) })).toEqual([]);

    // Below the days bar: three records on one UTC day.
    const oneDay = await custodyDir('home-oneday', [
      worktree('2026-11-30'), worktree('2026-11-30'), worktree('2026-11-30'),
    ]);
    expect(await custodyBacklogItems({ repo: 'ashlrai/phantom', homeDir: oneDay, now: new Date(NOW_MS) })).toEqual([]);

    // Missing custody dir and missing ledger file.
    const empty = await custodyDir('home-empty', []);
    expect(await custodyBacklogItems({ repo: 'ashlrai/phantom', homeDir: empty, now: new Date(NOW_MS) })).toEqual([]);
    expect(await custodyBacklogItems({ repo: 'ashlrai/phantom', homeDir: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);

    // A directory where the ledger should be is not a file.
    const dirAsFile = join(home, 'home-dirfile');
    await mkdir(join(dirAsFile, '.ashlr', 'custody', 'spawns.jsonl'), { recursive: true });
    expect(await custodyBacklogItems({ repo: 'ashlrai/phantom', homeDir: dirAsFile, now: new Date(NOW_MS) })).toEqual([]);

    // Garbage lines are not evidence.
    const junk = await custodyDir('home-junk', ['not json', '{"schema":1,"at":"2026-11-28T08:00:00.000Z"}', '']);
    expect(await custodyBacklogItems({ repo: 'ashlrai/phantom', homeDir: junk, now: new Date(NOW_MS) })).toEqual([]);

    // Deliberate-only evidence never emits.
    const deliberate = await custodyDir('home-deliberate', [
      ...recurring(disabled), ...recurring(selfAuth), ...recurring((d) => wrapped(at(d))),
    ]);
    expect(await custodyBacklogItems({ repo: 'ashlrai/phantom', homeDir: deliberate, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this install's evidence.
    const dir = await custodyDir('home-repo', recurring(worktree));
    expect(await custodyBacklogItems({ repo: 'ashlrai/other', homeDir: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await custodyBacklogItems({ repo: 'AshlrAI/Phantom', homeDir: dir, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('states truncated tails as lower bounds', async () => {
    // >CUSTODY_LEDGER_MAX_BYTES of retained rows: the bounded tail drops
    // the oldest bytes, so the recurring rows at the end still fold and
    // the prompt must say the counts are lower bounds.
    const filler: string[] = [];
    // Each row is ~140 bytes; this many clears the writer's per-file cap.
    for (let i = 0; i < Math.ceil(CUSTODY_LEDGER_MAX_BYTES / 120) + 500; i += 1) {
      filler.push(unwrapped(at(D1, i % 24), { reason: 'preflight-unavailable', engine: 'gemini' }));
    }
    const dir = await custodyDir('home-big', [...filler, ...recurring(worktree)]);
    const items = await custodyBacklogItems({ repo: 'ashlrai/phantom', homeDir: dir, now: new Date(NOW_MS) });
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.prompt.includes('lower bound'))).toBe(true);
  }, 60_000);

  it('never lets journal-carried text reach a prompt raw', async () => {
    // An engine name outside the writer's safe charset normalizes to
    // 'unknown' at parse — secret-shaped text cannot survive to a prompt.
    const token = '123456789:AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHJ';
    const dir = await custodyDir('home-secret', recurring((d) =>
      unwrapped(at(d), { engine: `evil ${token}` })));
    const items = await custodyBacklogItems({ repo: 'ashlrai/phantom', homeDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).not.toContain('AAAABBBB');
    expect(items[0]!.prompt).toContain('unknown×3');
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = await custodyDir('home-stable', [...recurring(worktree), ...recurring(preflightBlocked)]);
    const opts = { repo: 'ashlrai/phantom', homeDir: dir, now: new Date(NOW_MS) };
    const first = await custodyBacklogItems(opts);
    const second = await custodyBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('appends custody items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the evidence window on the wall clock, so
    // the fixtures use days relative to real now — three distinct UTC
    // days inside the window, like the fixed-date fixtures above. The
    // ledger lives at the writer's own path under the relocated HOME.
    const dayAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
    const recent = (make: (iso: string) => string): string[] => [1, 2, 3].map((d) => make(`${dayAgo(d)}T08:00:00.000Z`));
    const lines = [
      ...recent((iso) => unwrapped(iso)),
      ...recent((iso) => unwrapped(iso, { reason: 'preflight-blocked', preflight_exit: 1 })),
    ];
    await mkdir(join(home, '.ashlr', 'custody'), { recursive: true });
    await writeFile(join(home, LEDGER), lines.join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const custodyItems = first.items.filter((i) => i.id.startsWith('custody-'));
    expect(custodyItems.map((i) => i.id).sort()).toEqual(['custody-preflight-blocked', 'custody-worktree-namespace']);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(custodyItems)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('custody-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('custody-'))).toHaveLength(2);
  });
});
