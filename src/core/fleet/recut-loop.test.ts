/**
 * recut-loop.test.ts — the recut-loop tick's guards, caps and audit trail.
 * Every test runs against a temp runs dir and injected readers; nothing
 * touches the real home, the real fleet store, or the real gh.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MergeBacklogReadItem, MergeBacklogReadV1 } from './merge-backlog-read.js';
import type { MergedFleetPr } from './superseded-prs.js';
import { recutLoopTick, type RecutLoopDeps } from './recut-loop.js';

const NOW = Date.parse('2026-11-01T00:10:00.000Z');
const HEAD_SHA = '0123abcd'.repeat(5);
const HEADER = '#job repo=phantom lane=codex-personal tier=mid';

let runsDir: string;
let dropDir: string;
const prevOrchOff = process.env.ORCH_OFF;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'recut-loop-test-'));
  dropDir = join(runsDir, 'leader', 'drop', 'claude');
  delete process.env.ORCH_OFF;
});

afterEach(() => {
  if (prevOrchOff === undefined) delete process.env.ORCH_OFF;
  else process.env.ORCH_OFF = prevOrchOff;
  rmSync(runsDir, { recursive: true, force: true });
});

const item = (number: number, over: Partial<MergeBacklogReadItem> = {}): MergeBacklogReadItem => ({
  number,
  title: `bridge: RQ-PHX-RECUTJOB${number}`,
  headRef: `fleet/rq-phx-recutjob${number}`,
  updatedAt: '2026-11-01T00:00:00.000Z',
  mergeStateStatus: 'DIRTY',
  isDraft: false,
  job: `RQ-PHX-RECUTJOB${number}`,
  classification: { class: 'conflicted', work: 'refix', reason: 'merge-conflict' },
  suggestedAction: 'recut',
  ...over,
});

const backlog = (items: MergeBacklogReadItem[], source: MergeBacklogReadV1['source'] = 'ok'): MergeBacklogReadV1 => ({
  v: 1,
  repo: 'ashlrai/phantom',
  generatedAt: new Date(NOW).toISOString(),
  source,
  items,
  counts: {
    mergeState: { DIRTY: items.length },
    actions: { merge: 0, recut: items.length, refresh: 0, wait: 0, none: 0 },
  },
});

const deps = (items: MergeBacklogReadItem[], over: Partial<RecutLoopDeps> = {}): RecutLoopDeps => ({
  runsDir,
  readBacklog: async () => backlog(items),
  readMerged: async () => [],
  readHeadSha: async () => HEAD_SHA,
  now: () => NOW,
  ...over,
});

const ledgerPath = () => join(runsDir, 'queue', 'recut-loop.jsonl');
const ledgerLines = (): Record<string, unknown>[] =>
  readFileSync(ledgerPath(), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
const prompt = (name: string, body: string): void => {
  mkdirSync(join(runsDir, 'queue', 'prompts'), { recursive: true });
  writeFileSync(join(runsDir, 'queue', 'prompts', name), body);
};

describe('recutLoopTick', () => {
  it('writes one drop job for a DIRTY fleet PR with no recut yet', async () => {
    const result = await recutLoopTick(deps([item(15)]));

    expect(result.outcome).toBe('wrote');
    expect(result.written).toEqual([{ pr: 15, id: 'RECUT15L1', file: join(dropDir, 'RQ-PHX-RECUT15L1.md') }]);
    expect(result.skipped).toEqual([]);

    const files = readdirSync(dropDir);
    expect(files).toEqual(['RQ-PHX-RECUT15L1.md']);
    const body = readFileSync(join(dropDir, 'RQ-PHX-RECUT15L1.md'), 'utf8');
    expect(body.split('\n')[0]).toBe(HEADER);
    expect(body).toContain('PR #15');
    expect(body).toContain('pull/15/head');
    expect(body).toContain(HEAD_SHA);

    const ledger = ledgerLines();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ pr: 15, id: 'RECUT15L1', headSha: HEAD_SHA });
  });

  it('writes nothing on a second tick — the ledger dedupes within 24 h', async () => {
    const first = await recutLoopTick(deps([item(15)]));
    expect(first.outcome).toBe('wrote');

    const second = await recutLoopTick(deps([item(15)]));
    expect(second.outcome).toBe('nothing');
    expect(second.written).toEqual([]);
    expect(second.skipped).toEqual([{ pr: 15, reason: 'recent' }]);
    expect(readdirSync(dropDir)).toEqual(['RQ-PHX-RECUT15L1.md']);
    expect(ledgerLines()).toHaveLength(1);
  });

  it('skips a PR a merged job already recut — superseded', async () => {
    const merged: MergedFleetPr[] = [{ number: 900, title: 'bridge(RQ-PHX-MERGED1): RQ-PHX-MERGED1 landed (#900)' }];
    prompt('RQ-PHX-MERGED1.md', 'Recut the observed conflict in ashlrai/phantom PR #15 against a fresh origin/master.');

    const result = await recutLoopTick(deps([item(15)], { readMerged: async () => merged }));

    expect(result.outcome).toBe('nothing');
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([{ pr: 15, reason: 'superseded' }]);
    expect(existsSync(dropDir)).toBe(false);
    expect(existsSync(ledgerPath())).toBe(false);
  });

  it('skips a PR an in-flight prompt already names — in-flight', async () => {
    writeFileSync(join(runsDir, 'RQ-PHX-INFLIGHT1.prompt'), `already recutting\ngit fetch origin pull/15/head\n`);

    const result = await recutLoopTick(deps([item(15)]));

    expect(result.outcome).toBe('nothing');
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([{ pr: 15, reason: 'in-flight' }]);
    expect(existsSync(dropDir)).toBe(false);
  });

  it('in-flight detection also covers a drop file another producer left', async () => {
    mkdirSync(dropDir, { recursive: true });
    writeFileSync(join(dropDir, 'RQ-PHX-OTHER1.md'), `${HEADER}\n\n- \`git fetch origin pull/15/head\`\n`);

    const result = await recutLoopTick(deps([item(15)]));

    expect(result.outcome).toBe('nothing');
    expect(result.skipped).toEqual([{ pr: 15, reason: 'in-flight' }]);
    expect(readdirSync(dropDir)).toEqual(['RQ-PHX-OTHER1.md']);
  });

  it('caps at two writes per tick — the third candidate is capped', async () => {
    const result = await recutLoopTick(deps([item(15), item(16), item(17)]));

    expect(result.outcome).toBe('capped');
    expect(result.written.map((row) => row.pr)).toEqual([15, 16]);
    expect(result.skipped).toEqual([{ pr: 17, reason: 'capped' }]);
    expect(readdirSync(dropDir).sort()).toEqual(['RQ-PHX-RECUT15L1.md', 'RQ-PHX-RECUT16L1.md']);
    expect(ledgerLines()).toHaveLength(2);
  });

  it('caps at six writes in a rolling hour counted from the ledger', async () => {
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    const old = Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({ at: new Date(NOW - 30 * 60 * 1000).toISOString(), pr: 90 + i, id: `RECUT${90 + i}L1`, headSha: HEAD_SHA, file: '/x' }));
    writeFileSync(ledgerPath(), `${old.join('\n')}\n`);

    const result = await recutLoopTick(deps([item(15), item(16)]));

    expect(result.outcome).toBe('capped');
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([{ pr: 15, reason: 'capped' }, { pr: 16, reason: 'capped' }]);
    expect(existsSync(dropDir)).toBe(false);
  });

  it('the off switch file returns off and writes nothing', async () => {
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(join(runsDir, 'queue', 'recut-loop.off'), 'off\n');

    const result = await recutLoopTick(deps([item(15)]));

    expect(result.outcome).toBe('off');
    expect(result.written).toEqual([]);
    expect(existsSync(dropDir)).toBe(false);
    expect(existsSync(ledgerPath())).toBe(false);
  });

  it('the ORCH_OFF env var returns off and writes nothing', async () => {
    process.env.ORCH_OFF = '1';

    const result = await recutLoopTick(deps([item(15)]));

    expect(result.outcome).toBe('off');
    expect(result.written).toEqual([]);
    expect(existsSync(dropDir)).toBe(false);
  });

  it('a gh-failed backlog read returns read-failed and writes nothing', async () => {
    const result = await recutLoopTick(deps([item(15)], { readBacklog: async () => backlog([], 'gh-failed') }));

    expect(result.outcome).toBe('read-failed');
    expect(result.written).toEqual([]);
    expect(existsSync(dropDir)).toBe(false);
  });

  it('ignores candidates that are not recut actions or not bridge PRs', async () => {
    const items = [
      item(15, { suggestedAction: 'merge' }),
      item(16, { title: 'feat: ordinary PR title' }),
      item(17, { title: 'bridge: RQ-PHX-NOJOB1', suggestedAction: 'wait' }),
    ];

    const result = await recutLoopTick(deps(items));

    expect(result.outcome).toBe('nothing');
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(existsSync(dropDir)).toBe(false);
  });

  it('skips a candidate whose head sha cannot be observed', async () => {
    const result = await recutLoopTick(deps([item(15)], { readHeadSha: async () => null }));

    expect(result.outcome).toBe('nothing');
    expect(result.skipped).toEqual([{ pr: 15, reason: 'no-head' }]);
    expect(existsSync(dropDir)).toBe(false);
  });

  it('bumps the id when the drop file name is already taken', async () => {
    // No pull/<N>/head in this body, so the in-flight scan does not fire —
    // only the name collision forces RECUT15L2.
    mkdirSync(dropDir, { recursive: true });
    writeFileSync(join(dropDir, 'RQ-PHX-RECUT15L1.md'), `${HEADER}\n\ntaken\n`);

    const result = await recutLoopTick(deps([item(15)]));

    expect(result.outcome).toBe('wrote');
    expect(result.written).toEqual([{ pr: 15, id: 'RECUT15L2', file: join(dropDir, 'RQ-PHX-RECUT15L2.md') }]);
    expect(readdirSync(dropDir).sort()).toEqual(['RQ-PHX-RECUT15L1.md', 'RQ-PHX-RECUT15L2.md']);
  });
});
