/** readSurfaceOwner scopes the Phantom surface catalog to Hub-repo claims only. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import { readSurfaceOwner, SURFACES, type SurfaceOwnerDeps } from '../src/core/fleet/surface-owner.js';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const PHANTOM = 'ashlrai/phantom';
const FOREIGN = 'ashlrai/lexicon';
const SURFACE = 'slack-bridge';
const SURFACE_PATH = SURFACES[SURFACE]![0]!;
const TASK = 'watch the slack-bridge surface for fake work';
let home: string;
let ledger: string;
let deps: SurfaceOwnerDeps;

const claim = (repo: string, task: string, agent: string, now = NOW) => {
  const result = claimFleetWork({ repo, task, agent, ttlMs: 60_000 }, { path: ledger, now });
  if (!result.ok) throw new Error(`claim failed: ${result.error}`);
  return result.value.claim;
};
const gitLog: NonNullable<SurfaceOwnerDeps['log']> = async path =>
  path === 'src/core/agents/slack-transport.ts'
    ? [{ sha: 'abc1234', date: '2026-11-13T12:00:00.000Z', subject: 'bridge(RQ-PHX-FAKE1): surface work (#4242)', filesChanged: 3 }]
    : [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'surface-owner-repo-'));
  ledger = join(home, 'coordination.jsonl');
  deps = { now: () => NOW, board: options => readFleetBoard({ ...options, path: ledger }), log: gitLog };
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('surface-owner repository isolation', () => {
  it('a foreign-repo claim naming the surface id cannot become owner or a live claim', async () => {
    claim(FOREIGN, TASK, 'foreign-agent');
    const report = await readSurfaceOwner(SURFACE, deps);
    expect(report).toMatchObject({ authority: 'none', owner: 'UNKNOWN', ownerSource: 'none', liveClaims: [] });
    expect(report!.reasons).toContain('no live claim names this surface; lastLanded is history, not ownership');
    expect(report!.reasons).toContain('1 live claim(s) naming this surface belong to other repositories and were ignored');
    expect(report!.lastLanded).toMatchObject({ jobId: 'RQ-PHX-FAKE1', pr: 4242 });
    expect(JSON.stringify(report)).not.toContain(TASK);
    expect(JSON.stringify(report)).not.toContain('foreign-agent');
  });

  it('a foreign-repo claim naming an exact catalog path cannot become owner', async () => {
    claim(FOREIGN, `edit ${SURFACE_PATH} for fake work`, 'foreign-agent');
    const report = await readSurfaceOwner(SURFACE, deps);
    expect(report).toMatchObject({ owner: 'UNKNOWN', ownerSource: 'none', liveClaims: [] });
  });

  it('with foreign and Phantom claims only the Phantom owner appears', async () => {
    claim(FOREIGN, TASK, 'foreign-agent');
    claim(PHANTOM, 'phantom keeps the slack-bridge surface', 'phantom-agent');
    const report = await readSurfaceOwner(SURFACE, deps);
    expect(report).toMatchObject({ owner: 'phantom-agent', ownerSource: 'advisory-claim' });
    expect(report!.liveClaims).toEqual([{ id: expect.any(String), agent: 'phantom-agent', expiresInSeconds: 60 }]);
    expect(JSON.stringify(report)).not.toContain('foreign-agent');
  });

  it('the pre-rename Hub label still counts as this repository', async () => {
    claim('ashlrai/ashlr-hub', TASK, 'hub-agent');
    const report = await readSurfaceOwner(SURFACE, deps);
    expect(report).toMatchObject({ owner: 'hub-agent', ownerSource: 'advisory-claim' });
  });

  it('two distinct matching Phantom claims still produce ambiguity', async () => {
    claim(PHANTOM, TASK, 'phantom-agent-a');
    claim(PHANTOM, 'slack-bridge backup work', 'phantom-agent-b');
    const report = await readSurfaceOwner(SURFACE, deps);
    expect(report).toMatchObject({ owner: 'UNKNOWN', ownerSource: 'none' });
    expect(report!.liveClaims.map(c => c.agent).sort()).toEqual(['phantom-agent-a', 'phantom-agent-b']);
    expect(report!.reasons).toContain('2 live claims name this surface');
  });

  it('an expired Phantom claim remains excluded', async () => {
    claim(PHANTOM, TASK, 'gone-agent', NOW - 120_000);
    const expired = claimFleetWork({ repo: PHANTOM, task: 'short lived', agent: 'short-agent', ttlMs: 1 }, { path: ledger, now: NOW - 60_000 });
    expect(expired.ok).toBe(true);
    const report = await readSurfaceOwner(SURFACE, deps);
    expect(report).toMatchObject({ owner: 'UNKNOWN', ownerSource: 'none', liveClaims: [] });
    expect(report!.lastLanded).toMatchObject({ jobId: 'RQ-PHX-FAKE1' });
  });
});
