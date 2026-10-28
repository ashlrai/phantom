import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { laneContextOf } from '../src/core/bandit/context.js';
import { BANDIT_FLAG_ENV, banditConfigFrom, parseBanditFileConfig, resolveBanditFlag } from '../src/core/bandit/flag.js';
import { emptyBanditState, updateBanditState } from '../src/core/bandit/model.js';
import { mulberry32 } from '../src/core/bandit/rng.js';
import { outcomeRecordFrom } from '../src/core/bandit/rewards.js';
import { loadBanditState, recordOutcome, saveBanditState, selectLane } from '../src/core/bandit/select.js';
import {
  DEFAULT_BANDIT_CONFIG,
  type BanditLane,
} from '../src/core/bandit/types.js';

const lanes: BanditLane[] = [
  { id: 'devin', pool: 'devin' },
  { id: 'codex-personal', pool: 'codex-personal' },
];
const ctx = laneContextOf({ sizeLines: 300, repo: 'phantom', tier: 'work', pool: 'devin' }, DEFAULT_BANDIT_CONFIG);
const baseInput = {
  context: ctx,
  lanes,
  staticLaneId: 'codex-personal' as string | null,
  state: emptyBanditState(),
  uniform: mulberry32(5),
};

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bandit-flag-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('flag resolution', () => {
  it('defaults to shadow when nothing is configured', () => {
    const resolved = resolveBanditFlag({ root: tempDir(), env: {} });
    expect(resolved).toMatchObject({ mode: 'shadow', source: 'default' });
  });

  it('reads the mode from the flag file', () => {
    const root = tempDir();
    writeFileSync(join(root, 'router-bandit.json'), JSON.stringify({ mode: 'enforce' }));
    expect(resolveBanditFlag({ root, env: {} }).mode).toBe('enforce');
  });

  it('lets the environment override the file, and an invalid env value fails closed to off', () => {
    const root = tempDir();
    writeFileSync(join(root, 'router-bandit.json'), JSON.stringify({ mode: 'shadow' }));
    expect(resolveBanditFlag({ root, env: { [BANDIT_FLAG_ENV]: 'off' } }).mode).toBe('off');
    expect(resolveBanditFlag({ root, env: { [BANDIT_FLAG_ENV]: 'enforce' } }).source).toBe('env');
    const bad = resolveBanditFlag({ root, env: { [BANDIT_FLAG_ENV]: 'loud' } });
    expect(bad.mode).toBe('off');
    expect(bad.source).toBe('invalid');
  });

  it('fails closed to off when the flag file is malformed', () => {
    const root = tempDir();
    writeFileSync(join(root, 'router-bandit.json'), '{not json');
    const resolved = resolveBanditFlag({ root, env: {} });
    expect(resolved.mode).toBe('off');
    expect(resolved.error).toContain('not valid JSON');
  });

  it('parses a full file config and rejects malformed fields', () => {
    const good = parseBanditFileConfig(JSON.stringify({
      mode: 'shadow', creditFloor: 5, minCellSamples: 3, seed: 11,
      reward: { cost: 0.5, wallNormMs: 1000 },
      lanes: [{ id: 'devin', pool: 'devin' }],
    }));
    expect(good.error).toBeNull();
    expect(good.config).toMatchObject({ mode: 'shadow', creditFloor: 5, minCellSamples: 3, seed: 11 });
    const config = banditConfigFrom(good.config);
    expect(config.reward.cost).toBe(0.5);
    expect(config.reward.wallNormMs).toBe(1000);
    expect(config.reward.success).toBe(DEFAULT_BANDIT_CONFIG.reward.success);

    for (const bad of [
      { mode: 'loud' }, { creditFloor: -1 }, { minCellSamples: -1 }, { priorAlpha: 0 },
      { sizeEdges: [1, 2] }, { sizeEdges: [5, 4, 3, 2] }, { reward: { cost: -1 } },
      { reward: { bogus: 1 } }, { lanes: [{ id: 'x' }] }, { lanes: [{ id: 'x', pool: 'x' }, { id: 'x', pool: 'y' }] },
    ]) {
      expect(parseBanditFileConfig(JSON.stringify(bad)).config).toBeNull();
    }
  });
});

describe('selectLane modes', () => {
  it('off: the static route stands and the bandit is not consulted', () => {
    const decision = selectLane({ ...baseInput, mode: 'off' });
    expect(decision).toMatchObject({ laneId: 'codex-personal', sampledLaneId: null, divergent: false, holdReason: null });
  });

  it('shadow: samples a pick but applies the static route, flagging divergence', () => {
    const trained = updateBanditState(emptyBanditState(), ctx, 'devin', 1);
    const decision = selectLane({ ...baseInput, mode: 'shadow', state: trained });
    expect(decision.laneId).toBe('codex-personal');
    expect(decision.sampledLaneId).not.toBeNull();
    expect(lanes.map((lane) => lane.id)).toContain(decision.sampledLaneId);
    expect(decision.divergent).toBe(decision.sampledLaneId !== 'codex-personal');
  });

  it('enforce: applies the sampled lane among floor-eligible arms', () => {
    const decision = selectLane({ ...baseInput, mode: 'enforce' });
    expect(lanes.map((lane) => lane.id)).toContain(decision.laneId);
    expect(decision.sampledLaneId).toBe(decision.laneId);
    expect(decision.holdReason).toBeNull();
  });

  it('enforce: holds rather than route past the plan when no pool clears the floor', () => {
    const decision = selectLane({
      ...baseInput,
      mode: 'enforce',
      credits: { remaining: { devin: -1, 'codex-personal': -2 } },
    });
    expect(decision.laneId).toBeNull();
    expect(decision.holdReason).toBe('no lane clears the credit floor');
    expect(decision.reason).toContain('never routes past the plan');
  });

  it('enforce: excludes only the below-floor pool, never its neighbors', () => {
    const decision = selectLane({
      ...baseInput,
      mode: 'enforce',
      credits: { remaining: { devin: 100, 'codex-personal': -1 } },
    });
    expect(decision.laneId).toBe('devin');
    expect(decision.eligibleLaneIds).toEqual(['devin']);
  });

  it('never routes to a lane outside the supplied candidate set', () => {
    const decision = selectLane({
      ...baseInput,
      mode: 'enforce',
      lanes: [{ id: 'local', pool: 'local' }],
    });
    expect(decision.laneId).toBe('local');
  });
});

describe('recordOutcome and state store', () => {
  it('folds a merged-green outcome into posteriors for the logged lane', () => {
    const record = outcomeRecordFrom({
      schema: 'phantom-router-outcome/v1', job: 'RQ-1', at: '2026-10-20T00:00:00Z',
      pool: 'devin', repo: 'phantom', tier: 'work', sizeLines: 300,
      mergedAt: '2026-10-20T05:00:00Z', ciGreen: true, ciWallMs: 600_000, costUsd: 2,
    });
    const state = recordOutcome(emptyBanditState(), record);
    const cell = state.cells[['s', 'phantom', 'work', 'devin'].join('\n')]!;
    expect(cell['devin']!.n).toBe(1);
    expect(cell['devin']!.a).toBeGreaterThan(0.8);
  });

  it('persists state atomically and loads it back; a missing file is fresh state', () => {
    const dir = tempDir();
    expect(loadBanditState(dir)).toEqual({ v: 1, cells: {} });
    const state = updateBanditState(emptyBanditState(), ctx, 'devin', 0.9);
    saveBanditState(dir, state);
    expect(loadBanditState(dir)).toEqual(state);
    writeFileSync(join(dir, 'router-bandit-state.json'), '{broken');
    expect(loadBanditState(dir)).toEqual({ v: 1, cells: {} });
    expect(existsSync(join(dir, 'router-bandit-state.json'))).toBe(true);
  });

  it('creates the state directory when absent', () => {
    const dir = join(tempDir(), 'nested', 'state');
    saveBanditState(dir, emptyBanditState());
    expect(JSON.parse(readFileSync(join(dir, 'router-bandit-state.json'), 'utf8'))).toEqual({ v: 1, cells: {} });
  });
});
