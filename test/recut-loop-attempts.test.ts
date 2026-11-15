/**
 * recut-loop.test.ts — the recut-loop tick's guards, caps and audit trail.
 * Every test runs against a temp runs dir and injected readers; nothing
 * touches the real home, the real fleet store, or the real gh.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MergeBacklogReadItem, MergeBacklogReadV1 } from '../src/core/fleet/merge-backlog-read.js';
import { recutLoopTick, type RecutLoopDeps } from '../src/core/fleet/recut-loop.js';

const NOW = Date.parse('2026-11-01T00:10:00.000Z');
const HEAD_SHA = '0123abcd'.repeat(5);

let runsDir: string;
const prevOrchOff = process.env.ORCH_OFF;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'recut-loop-test-'));
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
  readLanded: async () => null,
  readUnionSafe: async () => false,
  now: () => NOW,
  ...over,
});

const prompt = (name: string, body: string): void => {
  mkdirSync(join(runsDir, 'queue', 'prompts'), { recursive: true });
  writeFileSync(join(runsDir, 'queue', 'prompts', name), body);
};


describe('recut attempt lifecycle', () => {
  const metrics = (events: string[]): void => {
    mkdirSync(join(runsDir, 'metrics'), { recursive: true });
    writeFileSync(join(runsDir, 'metrics', 'jobs.jsonl'), events.map(event => JSON.stringify({ event, job: 'RQ-PHX-RECUT15L1' })).join('\n'));
  };
  it('allows a completed attempt to retry, but blocks a later retry until it finishes', async () => {
    prompt('RQ-PHX-RECUT15L1.md', 'git fetch origin pull/15/head');
    metrics(['launch', 'finish', 'enqueue', 'launch']);
    expect((await recutLoopTick(deps([item(15)]))).skipped).toEqual([{ pr: 15, reason: 'in-flight' }]);
    metrics(['launch', 'finish', 'enqueue', 'launch', 'finish']);
    expect((await recutLoopTick(deps([item(15)]))).written).toHaveLength(1);
  });
  it('serializes overlapping ticks and deduplicates repeated backlog rows', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const first = recutLoopTick(deps([item(15), item(15)], { readHeadSha: async () => { entered(); await wait; return HEAD_SHA; } }));
    await started;
    const second = await recutLoopTick(deps([item(15)]));
    release();
    expect(second.written).toHaveLength(0);
    expect((await first).written).toHaveLength(1);
  });
});
