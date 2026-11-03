/**
 * recut-loop-landed-03.test.ts — the recut loop skips PRs whose work already
 * landed on master (dirty-landed read), failing open on anything else.
 * Injected deps only: no network, no real gh.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyDirtyLanded } from '../src/core/fleet/dirty-landed-inspect.js';
import type { MergeBacklogReadItem, MergeBacklogReadV1 } from '../src/core/fleet/merge-backlog-read.js';
import { recutLoopTick, type RecutLoopDeps } from '../src/core/fleet/recut-loop.js';

const NOW = Date.parse('2026-11-01T00:10:00.000Z');
const HEAD_SHA = '0123abcd'.repeat(5);

let runsDir: string;
const prevOrchOff = process.env.ORCH_OFF;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'recut-landed-test-'));
  delete process.env.ORCH_OFF;
});

afterEach(() => {
  if (prevOrchOff === undefined) delete process.env.ORCH_OFF;
  else process.env.ORCH_OFF = prevOrchOff;
  rmSync(runsDir, { recursive: true, force: true });
});

const item = (number: number): MergeBacklogReadItem => ({
  number,
  title: `bridge: RQ-PHX-RECUTLANDED${number}`,
  headRef: `fleet/rq-phx-recutlanded${number}`,
  updatedAt: '2026-11-01T00:00:00.000Z',
  mergeStateStatus: 'DIRTY',
  isDraft: false,
  job: `RQ-PHX-RECUTLANDED${number}`,
  classification: { class: 'conflicted', work: 'refix', reason: 'merge-conflict' },
  suggestedAction: 'recut',
});

const backlog = (items: MergeBacklogReadItem[]): MergeBacklogReadV1 => ({
  v: 1,
  repo: 'ashlrai/phantom',
  generatedAt: new Date(NOW).toISOString(),
  source: 'ok',
  items,
  counts: { mergeState: { DIRTY: items.length }, actions: { merge: 0, recut: items.length, refresh: 0, wait: 0, none: 0 } },
});

const deps = (items: MergeBacklogReadItem[], over: Partial<RecutLoopDeps>): RecutLoopDeps => ({
  runsDir,
  readBacklog: async () => backlog(items),
  readMerged: async () => [],
  readHeadSha: async () => HEAD_SHA,
  readUnionSafe: async () => false,
  now: () => NOW,
  ...over,
});

const dropped = (): string[] => readdirSync(join(runsDir, 'leader', 'drop', 'claude'));

describe('recutLoopTick landed guard', () => {
  it('skips the landed PR and writes the other', async () => {
    const result = await recutLoopTick(deps([item(21), item(22)], {
      readLanded: async ({ number }) => (number === 21 ? 'landed' : 'needs-recut'),
    }));

    expect(result.written.map((w) => w.pr)).toEqual([22]);
    expect(result.skipped).toEqual([{ pr: 21, reason: 'landed' }]);
    expect(dropped()).toHaveLength(1);
  });

  it('does not spend per-tick allowance on a landed skip', async () => {
    const result = await recutLoopTick(deps([item(31), item(32), item(33)], {
      readLanded: async ({ number }) => (number === 31 ? 'landed' : 'partly-landed'),
    }));

    expect(result.written.map((w) => w.pr)).toEqual([32, 33]);
    expect(result.skipped).toEqual([{ pr: 31, reason: 'landed' }]);
  });

  it('passes the pinned head and title to readLanded', async () => {
    const seen: unknown[] = [];
    await recutLoopTick(deps([item(41)], { readLanded: async (pr) => { seen.push(pr); return 'needs-recut'; } }));
    expect(seen).toEqual([{ number: 41, headSha: HEAD_SHA, title: 'bridge: RQ-PHX-RECUTLANDED41' }]);
  });

  it('fails open when readLanded throws', async () => {
    const result = await recutLoopTick(deps([item(51)], { readLanded: async () => { throw new Error('boom'); } }));
    expect(result.written.map((w) => w.pr)).toEqual([51]);
    expect(result.skipped).toEqual([]);
  });

  it("fails open when readLanded returns 'unknown'", async () => {
    const result = await recutLoopTick(deps([item(61)], { readLanded: async () => 'unknown' }));
    expect(result.written.map((w) => w.pr)).toEqual([61]);
    expect(result.skipped).toEqual([]);
  });
});

describe('classifyDirtyLanded', () => {
  it('is landed when no changed path still differs', () => {
    expect(classifyDirtyLanded(['a.ts', 'b.ts'], new Set())).toBe('landed');
  });
  it('is partly-landed when some changed paths still differ', () => {
    expect(classifyDirtyLanded(['a.ts', 'b.ts'], new Set(['b.ts']))).toBe('partly-landed');
  });
  it('is needs-recut when every changed path still differs', () => {
    expect(classifyDirtyLanded(['a.ts', 'b.ts'], new Set(['a.ts', 'b.ts', 'c.ts']))).toBe('needs-recut');
  });
});
