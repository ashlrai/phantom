import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdeaVerdictEntry } from '../src/core/ideas/idea-verdicts.js';
import {
  foldIdeaVerdictCell,
  ideaVerdictBacklogItems,
  ideaVerdictSource,
  IDEA_VERDICT_NEVER_RECURRING,
} from '../src/core/improve/idea-verdict-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

const verdict = (ideaId: string, kind: 'not-now' | 'never', msAgo: number, reason = ''): IdeaVerdictEntry => ({
  ideaId,
  verdict: kind,
  reason,
  at: at(msAgo),
});

describe('foldIdeaVerdictCell', () => {
  const opts = { nowMs: NOW, windowHours: 168 };

  it('emits at the recurring bar of distinct never verdicts and quotes not-now as context', () => {
    const cell = foldIdeaVerdictCell([
      verdict('phantom:issue:aaaa1111bb', 'never', 2 * DAY),
      verdict('ashlrai/phantom:invent:bbbb2222cccc3333', 'never', DAY),
      verdict('phantom:test:cccc3333dd', 'never', 3 * HOUR),
      verdict('phantom:goal:dddd4444ee', 'not-now', HOUR),
      verdict('phantom:hygiene:eeee5555ff', 'not-now', 2 * HOUR),
    ], opts);
    expect(cell).not.toBeNull();
    expect(cell).toMatchObject({ never: 3, notNow: 2 });
    expect(cell!.bySource).toEqual([
      { source: 'invent', count: 1 },
      { source: 'issue', count: 1 },
      { source: 'test', count: 1 },
    ]);
    expect(cell!.examples).toContain('phantom:issue:aaaa1111bb');
    expect(cell!.firstSeen).toBe(at(2 * DAY));
    expect(cell!.lastSeen).toBe(at(HOUR));
  });

  it('never emits below the recurring bar or on not-now verdicts alone', () => {
    expect(IDEA_VERDICT_NEVER_RECURRING).toBe(3);
    expect(foldIdeaVerdictCell([
      verdict('a:issue:111111aaaa', 'never', DAY),
      verdict('b:issue:222222bbbb', 'never', 2 * DAY),
    ], opts)).toBeNull();
    expect(foldIdeaVerdictCell([
      verdict('a:issue:111111aaaa', 'not-now', DAY),
      verdict('b:issue:222222bbbb', 'not-now', 2 * DAY),
      verdict('c:issue:333333cccc', 'not-now', 3 * DAY),
      verdict('d:issue:444444dddd', 'not-now', 4 * DAY),
      verdict('e:issue:555555eeee', 'not-now', 5 * DAY),
    ], opts)).toBeNull();
  });

  it('ignores verdicts outside the window, past the skew, and with unparseable stamps', () => {
    expect(foldIdeaVerdictCell([
      verdict('old1:issue:111111aaaa', 'never', 8 * DAY),
      verdict('old2:issue:222222bbbb', 'never', 9 * DAY),
      verdict('old3:issue:333333cccc', 'never', 10 * DAY),
      verdict('fut1:issue:444444dddd', 'never', -2 * 60 * 1000),
      verdict('fut2:issue:555555eeee', 'never', -3 * 60 * 1000),
      verdict('fut3:issue:666666ffff', 'never', -4 * 60 * 1000),
      { ideaId: 'bad:issue:777777aaaa', verdict: 'never', reason: '', at: 'not-a-date' },
      verdict('in1:issue:888888bbbb', 'never', 2 * DAY),
      verdict('in2:issue:999999cccc', 'never', DAY),
    ], opts)).toBeNull();
    // Inside the one-minute skew the stamp still counts as same-host drift.
    const cell = foldIdeaVerdictCell([
      verdict('s1:issue:111111aaaa', 'never', -30 * 1000),
      verdict('s2:issue:222222bbbb', 'never', -20 * 1000),
      verdict('s3:issue:333333cccc', 'never', -10 * 1000),
    ], opts);
    expect(cell).toMatchObject({ never: 3, notNow: 0 });
  });

  it('keeps the latest verdict per idea id so a re-verdict never double-counts', () => {
    const cell = foldIdeaVerdictCell([
      verdict('same:issue:111111aaaa', 'never', 5 * DAY),
      verdict('same:issue:111111aaaa', 'not-now', DAY),
      verdict('n1:issue:222222bbbb', 'never', 2 * DAY),
      verdict('n2:issue:333333cccc', 'never', DAY),
    ], opts);
    // 'same' resolves to its later not-now verdict: only two never ideas remain.
    expect(cell).toBeNull();
    const cell2 = foldIdeaVerdictCell([
      verdict('same:issue:111111aaaa', 'not-now', 5 * DAY),
      verdict('same:issue:111111aaaa', 'never', DAY),
      verdict('n1:issue:222222bbbb', 'never', 2 * DAY),
      verdict('n2:issue:333333cccc', 'never', 3 * DAY),
    ], opts);
    expect(cell2).toMatchObject({ never: 3, notNow: 0 });
  });

  it('tallies unattributed and unsafe ids honestly and quotes only safe-shaped examples', () => {
    const cell = foldIdeaVerdictCell([
      verdict('no-colons-here', 'never', 2 * DAY),
      verdict('phantom:not-a-source:aaaa1111bb', 'never', DAY),
      verdict('phantom:issue:nothex!!', 'never', 3 * HOUR),
      verdict('evil id with spaces:issue:aaaa1111bb', 'never', HOUR),
      verdict('ok1:issue:bbbb2222cc', 'never', 2 * HOUR),
      verdict('ok2:test:cccc3333dd', 'never', HOUR),
    ], opts);
    expect(cell).not.toBeNull();
    // The id with spaces still ends in the ':issue:<hex>' contract, so its
    // source parses; it is counted but never quoted as an example.
    expect(cell!.bySource).toEqual([
      { source: 'unattributed', count: 3 },
      { source: 'issue', count: 2 },
      { source: 'test', count: 1 },
    ]);
    expect(cell!.examples).not.toContain('evil id with spaces:issue:aaaa1111bb');
    expect(cell!.examples).toContain('ok1:issue:bbbb2222cc');
  });
});

describe('ideaVerdictSource', () => {
  it('reads the WorkSource segment from the right of the id contract', () => {
    expect(ideaVerdictSource('phantom:issue:abc123def4')).toBe('issue');
    expect(ideaVerdictSource('ashlrai/phantom:invent:0123456789abcdef')).toBe('invent');
    expect(ideaVerdictSource('weird:name:with:colons:goal:ffffeeee0000')).toBe('goal');
    expect(ideaVerdictSource('short:issue:abc')).toBeNull();
    expect(ideaVerdictSource('phantom:bogus:abc123def4')).toBeNull();
    expect(ideaVerdictSource('phantom:issue:NOT-HEX!!')).toBeNull();
    expect(ideaVerdictSource('plain-id')).toBeNull();
  });
});

describe('ideaVerdictBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
    delete process.env.ASHLR_HOME;
    home = await mkdtemp(join(tmpdir(), 'idea-verdict-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  const verdictsPath = (): string => join(home, '.ashlr', 'idea-verdicts.jsonl');

  const writeVerdicts = async (lines: readonly string[]): Promise<void> => {
    await mkdir(join(home, '.ashlr'), { recursive: true });
    await writeFile(verdictsPath(), `${lines.join('\n')}\n`);
  };

  const line = (ideaId: string, kind: 'not-now' | 'never', msAgo: number, reason = ''): string =>
    JSON.stringify({ ideaId, verdict: kind, reason, at: at(msAgo) });

  it('emits an idea-verdicts item for recurring never verdicts and validates it', async () => {
    await writeVerdicts([
      line('phantom:issue:aaaa1111bb', 'never', 5 * DAY, 'owner prose that must never be quoted'),
      line('phantom:invent:bbbb2222cccc3333', 'never', 3 * DAY),
      line('phantom:test:cccc3333dd', 'never', DAY),
      line('phantom:goal:dddd4444ee', 'not-now', 2 * HOUR, 'deferred for later'),
      'not json at all',
    ]);
    const items = await ideaVerdictBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'idea-verdicts' });
    expect(item!.id).toMatch(/^idea-verdict-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.title).toContain('never');
    expect(item!.prompt).toContain('3 distinct idea(s) carry a standing \'never\' verdict');
    expect(item!.prompt).toContain('1 additional distinct idea(s) carry a standing \'not now\' deferral');
    expect(item!.prompt).toContain('idea-verdicts.jsonl');
    expect(item!.prompt).toContain('readIdeaVerdicts');
    expect(item!.prompt).toContain('declinedIdeaFeedback');
    expect(item!.prompt).toContain('liveIdeaVerdicts');
    expect(item!.prompt).toContain('scanners.ts');
    expect(item!.prompt).toContain('invent-cycle.ts');
    expect(item!.prompt).toContain('no-change');
    // Reason prose is never quoted; only bounded structural fields are.
    expect(item!.prompt).not.toContain('owner prose that must never be quoted');
    expect(item!.prompt).not.toContain('deferred for later');
    expect(item!.prompt).toContain('phantom:issue:aaaa1111bb');
  });

  it('emits nothing below the bar, for a missing journal, not-now-only, or another repository', async () => {
    // Below the recurring bar.
    await writeVerdicts([
      line('a:issue:111111aaaa', 'never', 2 * DAY),
      line('b:issue:222222bbbb', 'never', DAY),
    ]);
    expect(await ideaVerdictBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW) })).toEqual([]);

    // Not-now verdicts alone never trigger.
    await writeVerdicts([
      line('a:issue:111111aaaa', 'not-now', DAY),
      line('b:issue:222222bbbb', 'not-now', 2 * DAY),
      line('c:issue:333333cccc', 'not-now', 3 * DAY),
      line('d:issue:444444dddd', 'not-now', 4 * DAY),
    ]);
    expect(await ideaVerdictBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW) })).toEqual([]);

    // Verdicts outside the window are stale evidence.
    await writeVerdicts([
      line('a:issue:111111aaaa', 'never', 8 * DAY),
      line('b:issue:222222bbbb', 'never', 9 * DAY),
      line('c:issue:333333cccc', 'never', 10 * DAY),
    ]);
    expect(await ideaVerdictBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW) })).toEqual([]);

    // Missing journal file.
    await rm(verdictsPath(), { force: true });
    expect(await ideaVerdictBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW) })).toEqual([]);

    // Another repository inherits nothing — verdicts carry no repo column.
    await writeVerdicts([
      line('a:issue:111111aaaa', 'never', 2 * DAY),
      line('b:issue:222222bbbb', 'never', DAY),
      line('c:issue:333333cccc', 'never', 3 * DAY),
    ]);
    expect(await ideaVerdictBacklogItems({ repo: 'ashlrai/other', now: new Date(NOW) })).toEqual([]);
    expect(await ideaVerdictBacklogItems({ repo: 'AshlrAI/Phantom', now: new Date(NOW) })).toHaveLength(1);
  });

  it('honours the latest-verdict-per-idea contract the producers apply', async () => {
    await writeVerdicts([
      // 'same' was verdicted never then re-verdicted not-now: standing verdict is not-now.
      line('same:issue:111111aaaa', 'never', 6 * DAY),
      line('same:issue:111111aaaa', 'not-now', DAY),
      line('n1:issue:222222bbbb', 'never', 2 * DAY),
      line('n2:issue:333333cccc', 'never', 3 * DAY),
    ]);
    expect(await ideaVerdictBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW) })).toEqual([]);
  });

  it('derives a stable id so a refresh re-adds nothing and honours the limit', async () => {
    await writeVerdicts([
      line('a:issue:111111aaaa', 'never', 2 * DAY),
      line('b:issue:222222bbbb', 'never', DAY),
      line('c:issue:333333cccc', 'never', 3 * DAY),
    ]);
    const opts = { repo: 'ashlrai/phantom', now: new Date(NOW) };
    const first = await ideaVerdictBacklogItems(opts);
    const second = await ideaVerdictBacklogItems(opts);
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    expect(first).toHaveLength(1);
    expect(await ideaVerdictBacklogItems({ ...opts, limit: 1 })).toHaveLength(1);
  });

  it('appends the idea-verdict item through discovery and dedupes on refresh', async () => {
    await writeVerdicts([
      line('a:issue:111111aaaa', 'never', 2 * DAY),
      line('b:issue:222222bbbb', 'never', DAY),
      line('c:issue:333333cccc', 'never', 3 * DAY),
    ]);
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const verdictItems = first.items.filter((i) => i.id.startsWith('idea-verdict-'));
    expect(verdictItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(verdictItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('idea-verdict-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('idea-verdict-'))).toHaveLength(1);
  });
});
