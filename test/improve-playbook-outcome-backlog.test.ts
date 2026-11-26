import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLAYBOOK_OUTCOME_ADVERSE_DAYS,
  PLAYBOOK_OUTCOME_ADVERSE_RECURRING,
  PLAYBOOK_OUTCOME_MAX_ITEMS,
  PLAYBOOK_OUTCOME_WINDOW_HOURS,
  playbookOutcomeBacklogItems,
} from '../src/core/improve/playbook-outcome-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  appendUserBacklogItems,
  readUserBacklogItems,
  validBacklogItem,
} from '../src/core/cloud/backlog.js';
import type { RetroEndKind, RetroV1 } from '../src/core/learn/retro/types.js';
import type { PlaybookV1 } from '../src/core/playbooks/types.js';
import { MAX_RETROS } from '../src/core/learn/retro/store.js';

vi.mock('../src/core/improve/playbook-outcome-backlog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/improve/playbook-outcome-backlog.js')>();
  return { ...actual, playbookOutcomeBacklogItems: vi.fn(actual.playbookOutcomeBacklogItems) };
});

const realFeed = (await vi.importActual<typeof import('../src/core/improve/playbook-outcome-backlog.js')>(
  '../src/core/improve/playbook-outcome-backlog.js',
)).playbookOutcomeBacklogItems;
const feedMock = vi.mocked(playbookOutcomeBacklogItems);

const REPO = 'ashlrai/phantom';
const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const PB_A = 'fix-failing-test';
const PB_B = 'write-docs';
const PB_C = 'gone-playbook';

function playbook(id: string, version = 1, over: Partial<PlaybookV1['meta']> = {}): PlaybookV1 {
  return {
    v: 1,
    meta: {
      id,
      name: `Playbook ${id}`,
      macro: `!${id}`,
      description: `Does ${id} things`,
      appliesTo: { repos: [], globs: [] },
      taskKinds: [],
      doneWhen: [],
      budget: { usd: null, minutes: null },
      auto: false,
      ...over,
    },
    sections: {},
    version,
    sha: 'a'.repeat(12),
    source: `---\nid: ${id}\nname: Playbook ${id}\nmacro: !${id}\n---\n\n## Outcome\nDone.\n`,
    createdAt: '2026-09-01T00:00:00.000Z',
    builtin: false,
  };
}

function retro(id: string, endKind: RetroEndKind, endedAt: string, playbookRef?: { id: string; version: number; sha: string }): RetroV1 {
  return {
    v: 1,
    id: `rt_${id.padStart(20, '0').slice(-20)}`,
    sourceKey: `test:${id}`,
    source: 'fleet',
    taskId: `task-${id}`,
    repo: 'ashlrai/phantom',
    endKind,
    endedAt,
    taskKind: 'fix',
    asked: 'Fix the thing',
    happened: 'It ended.',
    rootCause: null,
    doDifferently: [],
    betterPrompt: null,
    candidates: [],
    paths: [],
    model: null,
    createdAt: endedAt,
    ...(playbookRef ? { playbookRef } : {}),
  };
}

const ref = (id: string, version = 1) => ({ id, version, sha: 'a'.repeat(12) });
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/** Three adverse runs across two distinct UTC days inside the window. */
function recurringRetros(pbId: string, version = 1): RetroV1[] {
  return [
    retro('a1', 'reverted', iso(1 * DAY), ref(pbId, version)),
    retro('a2', 'failed', iso(2 * DAY), ref(pbId, version)),
    retro('a3', 'verify-failed', iso(3 * DAY), ref(pbId, version)),
    retro('a4', 'merged', iso(4 * DAY), ref(pbId, version)),
  ];
}

const LIVE = [playbook(PB_A), playbook(PB_B, 2), playbook('other-live')];

let previousAshlrHome: string | undefined;
let home: string;

beforeEach(() => {
  feedMock.mockReset();
  feedMock.mockImplementation(realFeed);
  previousAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-playbook-outcome-backlog-'));
  process.env.ASHLR_HOME = home;
});

afterEach(() => {
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

describe('playbookOutcomeBacklogItems', () => {
  it('emits one valid item per live playbook version at the recurring adverse bar', async () => {
    const items = await playbookOutcomeBacklogItems({
      repo: REPO,
      retros: recurringRetros(PB_A),
      playbooks: LIVE,
      now: NOW,
    });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.id).toMatch(/^playbook-outcome-[0-9a-f]{16}$/);
    expect(item.title).toContain('Playbook fix-failing-test');
    expect(item.title).toContain('v1');
    expect(item.area).toBe('playbook-outcomes');
    expect(item.priority).toBe(3);
    expect(item.repo).toBe(REPO);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.prompt).toContain(PB_A);
    expect(item.prompt).toContain('v1');
    expect(item.prompt).toContain('4 ended runs');
    expect(item.prompt).toContain('merged 1');
    expect(item.prompt).toContain('reverted 1');
    expect(item.prompt).toContain('failed 2');
    expect(item.prompt).toContain('refused-or-gated 0');
    expect(item.prompt).toContain('3 adverse across 3 distinct UTC day(s)');
    expect(item.prompt).toContain('descriptive tallies, not a causal verdict');
    expect(item.prompt).toContain('countPlaybookOutcomes');
    expect(item.prompt).toContain('uses.jsonl');
    expect(item.prompt).toContain('no-change');
  });

  it('stays quiet below the adverse bar and on a single adverse day', async () => {
    // Two adverse runs never reach the bar.
    const two = await playbookOutcomeBacklogItems({
      repo: REPO,
      retros: [
        retro('b1', 'reverted', iso(1 * DAY), ref(PB_A)),
        retro('b2', 'failed', iso(2 * DAY), ref(PB_A)),
        retro('b3', 'merged', iso(3 * DAY), ref(PB_A)),
      ],
      playbooks: LIVE,
      now: NOW,
    });
    expect(two).toEqual([]);
    // Three adverse runs all on one UTC day never reach the day bar.
    const sameDay = await playbookOutcomeBacklogItems({
      repo: REPO,
      retros: [
        retro('c1', 'reverted', '2026-11-19T01:00:00.000Z', ref(PB_A)),
        retro('c2', 'failed', '2026-11-19T05:00:00.000Z', ref(PB_A)),
        retro('c3', 'expired', '2026-11-19T23:00:00.000Z', ref(PB_A)),
      ],
      playbooks: LIVE,
      now: NOW,
    });
    expect(sameDay).toEqual([]);
  });

  it('never counts refused end kinds toward the adverse bar', async () => {
    const items = await playbookOutcomeBacklogItems({
      repo: REPO,
      retros: [
        retro('d1', 'gate-refused', iso(1 * DAY), ref(PB_A)),
        retro('d2', 'owner-laned', iso(2 * DAY), ref(PB_A)),
        retro('d3', 'closed', iso(3 * DAY), ref(PB_A)),
        retro('d4', 'vetoed', iso(4 * DAY), ref(PB_A)),
      ],
      playbooks: LIVE,
      now: NOW,
    });
    expect(items).toEqual([]);
  });

  it('emits only while the playbook id still resolves', async () => {
    const retros = recurringRetros(PB_C);
    // PB_C is absent from the live set — a deleted playbook's history is moot.
    expect(await playbookOutcomeBacklogItems({ repo: REPO, retros, playbooks: LIVE, now: NOW })).toEqual([]);
    // A failed live-playbook read withholds every row the same way.
    expect(await playbookOutcomeBacklogItems({ repo: REPO, retros, playbooks: null as never, now: NOW })).toEqual([]);
  });

  it('counts each id@version cell independently and orders by adverse evidence', async () => {
    const items = await playbookOutcomeBacklogItems({
      repo: REPO,
      retros: [
        // PB_A v1: 3 adverse.
        ...recurringRetros(PB_A, 1),
        // PB_B v2: 4 adverse (reverted x2 + failed x2) across three days.
        retro('e1', 'reverted', iso(1 * DAY), ref(PB_B, 2)),
        retro('e2', 'reverted', iso(2 * DAY), ref(PB_B, 2)),
        retro('e3', 'failed', iso(3 * DAY), ref(PB_B, 2)),
        retro('e4', 'expired', iso(4 * DAY), ref(PB_B, 2)),
        // PB_B v1 rows exist but stay below the bar — a different version is a different cell.
        retro('e5', 'failed', iso(1 * DAY), ref(PB_B, 1)),
        retro('e6', 'failed', iso(2 * DAY), ref(PB_B, 1)),
      ],
      playbooks: [playbook(PB_A), playbook(PB_B, 2)],
      now: NOW,
    });
    expect(items).toHaveLength(2);
    expect(items[0]!.prompt).toContain(`${PB_B}`);
    expect(items[0]!.prompt).toContain('v2');
    expect(items[0]!.prompt).toContain('4 adverse');
    expect(items[1]!.prompt).toContain(`${PB_A}`);
    expect(items[1]!.prompt).toContain('v1');
  });

  it('windows on endedAt and skips rows outside it or without a usable ref', async () => {
    const items = await playbookOutcomeBacklogItems({
      repo: REPO,
      retros: [
        // All three adverse rows are older than the window — nothing emits.
        retro('f1', 'reverted', iso(PLAYBOOK_OUTCOME_WINDOW_HOURS * 60 * 60 * 1000 + DAY), ref(PB_A)),
        retro('f2', 'failed', iso(PLAYBOOK_OUTCOME_WINDOW_HOURS * 60 * 60 * 1000 + 2 * DAY), ref(PB_A)),
        retro('f3', 'expired', iso(PLAYBOOK_OUTCOME_WINDOW_HOURS * 60 * 60 * 1000 + 3 * DAY), ref(PB_A)),
        // Malformed refs and missing refs never reach a cell.
        retro('f4', 'reverted', iso(1 * DAY), { id: 'BAD ID!', version: 1, sha: 'x' }),
        retro('f5', 'reverted', iso(1 * DAY), { id: PB_A, version: 0, sha: 'x' }),
        retro('f6', 'reverted', iso(1 * DAY)),
        retro('f7', 'reverted', 'not-a-date', ref(PB_A)),
      ],
      playbooks: LIVE,
      now: NOW,
    });
    expect(items).toEqual([]);
  });

  it('skips retros stamped past the evaluation-time future skew', async () => {
    // Three adverse rows all stamped beyond now + skew: corrupt or replayed
    // evidence, never reaches a cell.
    const future = await playbookOutcomeBacklogItems({
      repo: REPO,
      retros: [
        retro('i1', 'reverted', new Date(NOW + 2 * 60_000).toISOString(), ref(PB_A)),
        retro('i2', 'failed', new Date(NOW + 60 * 60_000).toISOString(), ref(PB_A)),
        retro('i3', 'expired', new Date(NOW + DAY).toISOString(), ref(PB_A)),
      ],
      playbooks: LIVE,
      now: NOW,
    });
    expect(future).toEqual([]);
    // A future stamp cannot push a below-bar cell over it either.
    const mixed = await playbookOutcomeBacklogItems({
      repo: REPO,
      retros: [
        retro('i4', 'reverted', iso(1 * DAY), ref(PB_A)),
        retro('i5', 'failed', iso(2 * DAY), ref(PB_A)),
        retro('i6', 'expired', new Date(NOW + DAY).toISOString(), ref(PB_A)),
      ],
      playbooks: LIVE,
      now: NOW,
    });
    expect(mixed).toEqual([]);
    // Inside the one-minute skew the stamp still counts as same-host drift.
    const within = await playbookOutcomeBacklogItems({
      repo: REPO,
      retros: [
        retro('i7', 'reverted', iso(1 * DAY), ref(PB_A)),
        retro('i8', 'failed', iso(2 * DAY), ref(PB_A)),
        retro('i9', 'expired', new Date(NOW + 30_000).toISOString(), ref(PB_A)),
      ],
      playbooks: LIVE,
      now: NOW,
    });
    expect(within).toHaveLength(1);
    expect(within[0]!.prompt).toContain('3 adverse across 3 distinct UTC day(s)');
  });

  it('states the retro bound as a lower bound when the window may be truncated', async () => {
    // MAX_RETROS rows all inside the window: the 500-cap can hide older
    // in-window runs, so the prompt must say the tallies are lower bounds.
    const rows: RetroV1[] = [];
    for (let i = 0; i < MAX_RETROS; i++) {
      rows.push(retro(`t${i}`, i % 4 === 0 ? 'merged' : i % 3 === 0 ? 'reverted' : 'failed', iso((i % 6 + 1) * DAY), ref(PB_A)));
    }
    const items = await playbookOutcomeBacklogItems({ repo: REPO, retros: rows, playbooks: LIVE, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.prompt).toContain('lower bounds');
    expect(items[0]!.prompt).toContain(String(MAX_RETROS));
  });

  it('gates on the fleet repository and derives stable ids', async () => {
    const opts = { repo: REPO, retros: recurringRetros(PB_A), playbooks: LIVE, now: NOW };
    expect(await playbookOutcomeBacklogItems({ ...opts, repo: 'ashlrai/other-repo' })).toEqual([]);
    const first = await playbookOutcomeBacklogItems(opts);
    const second = await playbookOutcomeBacklogItems(opts);
    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id));
    // Shifted tallies on the same version keep the same id — no twin items.
    const shifted = await playbookOutcomeBacklogItems({
      ...opts,
      retros: [...recurringRetros(PB_A), retro('g1', 'failed', iso(5 * DAY), ref(PB_A))],
    });
    expect(shifted.map((item) => item.id)).toEqual(first.map((item) => item.id));
    // A bare repository name still matches the fleet gate but carries no owner/repo field.
    const bare = await playbookOutcomeBacklogItems({ ...opts, repo: 'phantom' });
    expect(bare).toHaveLength(1);
    expect(bare[0]!.repo).toBeUndefined();
  });

  it('orders candidates by adverse count then total and honors the limit', async () => {
    const items = await playbookOutcomeBacklogItems({
      repo: REPO,
      retros: [
        ...recurringRetros(PB_A),
        retro('h1', 'reverted', iso(1 * DAY), ref(PB_B, 2)),
        retro('h2', 'reverted', iso(2 * DAY), ref(PB_B, 2)),
        retro('h3', 'reverted', iso(3 * DAY), ref(PB_B, 2)),
        retro('h4', 'failed', iso(4 * DAY), ref(PB_B, 2)),
        retro('h5', 'merged', iso(5 * DAY), ref(PB_B, 2)),
      ],
      playbooks: LIVE,
      now: NOW,
      limit: 1,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain(`${PB_B}`);
    expect(items[0]!.prompt).toContain('4 adverse');
  });

  it('scrubs secret-shaped playbook names out of titles and prompts', async () => {
    const secretName = `Run ghp_${'a'.repeat(36)} first`;
    const items = await playbookOutcomeBacklogItems({
      repo: REPO,
      retros: recurringRetros(PB_A),
      playbooks: [playbook(PB_A, 1, { name: secretName })],
      now: NOW,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).not.toContain('ghp_');
    expect(items[0]!.prompt).not.toContain('ghp_');
    expect(items[0]!.title + items[0]!.prompt).toContain('[REDACTED]');
  });

  it('reads the real playbook store under the isolated home', async () => {
    // Built-ins are always live: fix-failing-test resolves with no disk
    // writes, so injected retros against it exercise the real
    // listLatestPlaybooks read end to end.
    const items = await playbookOutcomeBacklogItems({
      repo: REPO,
      retros: recurringRetros('fix-failing-test'),
      now: NOW,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('fix-failing-test');
    expect(items[0]!.prompt).toContain('Fix a failing test');
  });
});

describe('playbookOutcomeBacklogItems constants', () => {
  it('exposes the documented window, bars and item bounds', () => {
    expect(PLAYBOOK_OUTCOME_WINDOW_HOURS).toBe(24 * 7);
    expect(PLAYBOOK_OUTCOME_ADVERSE_RECURRING).toBe(3);
    expect(PLAYBOOK_OUTCOME_ADVERSE_DAYS).toBe(2);
    expect(PLAYBOOK_OUTCOME_MAX_ITEMS).toBeGreaterThan(0);
  });
});

describe('discoverBacklog wiring', () => {
  const greenGh = async (args: string[]) => {
    const path = args[4] ?? '';
    if (path === 'repos/ashlrai/phantom') {
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
    }
    return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
  };

  it('appends feed items through discovery and dedupes on refresh', async () => {
    const sentinel = {
      id: 'playbook-outcome-cafebabecafebabe',
      title: 'Playbook sentinel v1 keeps landing reverted or failed runs',
      prompt: 'Sentinel prompt naming the playbook-outcome evidence.',
      area: 'playbook-outcomes',
      priority: 3 as const,
      repo: REPO,
    };
    feedMock.mockResolvedValueOnce([sentinel]);
    const first = await discoverBacklog(REPO, { gh: greenGh });
    expect(feedMock).toHaveBeenCalledWith({ repo: REPO });
    const noteItems = first.items.filter((item) => item.id === sentinel.id);
    expect(noteItems).toHaveLength(1);
    expect(first.items.every((item) => validBacklogItem(item) !== null)).toBe(true);
    expect(appendUserBacklogItems(noteItems)).toBe(1);
    feedMock.mockResolvedValueOnce([sentinel]);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((item) => item.id === sentinel.id))).toBe(0);
    expect(readUserBacklogItems().filter((item) => item.id === sentinel.id)).toHaveLength(1);
  });
});
