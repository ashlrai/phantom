import { expect, it } from 'vitest';
import type { NodesSnapshot } from '../../../../core/nodes/view.js';
import type { OpsReleasesV1 } from '../../../../core/verse/ops-types.js';
import { buildLivePanels, type LivePanelsInput } from './live-panels-model.js';

const runs = {
  lanes: [
    { lane: 'claude', running: 2, target: 8, queued: 1, held: false, heldReason: null, tokensLastHour: 1200 },
    { lane: 'grok', running: 0, target: 4, queued: 0, held: true, heldReason: 'quota', tokensLastHour: 0 },
  ],
  mergesLastHour: { count: 2, items: [{ repo: 'ashlrai/phantom', number: 7, title: 'Fix it' }, { repo: 'ashlrai/phantom', number: 8, title: 'Add it' }] },
  codexPersonal: { usedPct: 41.6, resetsAt: null, asOf: null },
};
const releases = { v: 1, generatedAt: 'x', sourceState: 'healthy', repos: [
  { repo: 'ashlrai/phantom', version: '1.2.0', latestTag: 'v1.2.0', commitsSinceTag: 3 },
  { repo: 'ashlrai/site', version: null, latestTag: null },
] } as unknown as OpsReleasesV1;
const nodes = { nodes: [{ id: 'mbp', status: 'ready', leader: true }, { id: 'mini', status: 'down', leader: false }], error: null } as unknown as NodesSnapshot;
const roster = { schema: 'agent-roster.v1', claims: { items: [{ owner: 'claude', completed: false }, { owner: 'claude', completed: false }, { owner: 'grok', completed: true }] } };
const live: LivePanelsInput = { runs, releases, nodes, roster };
const by = (input: LivePanelsInput) => Object.fromEntries(buildLivePanels(input).map(p => [p.id, p]));

it('builds six live panels from reported readings only', () => {
  const p = by(live);
  expect(Object.keys(p)).toEqual(['fleet', 'merges', 'releases', 'nodes', 'agents', 'spend']);
  expect(p.fleet).toMatchObject({ state: 'live', headline: '2 of 12 slots running' });
  expect(p.fleet!.rows).toContainEqual({ label: 'Held', value: 'grok' });
  expect(p.merges!.headline).toBe('2 merges in the last hour');
  expect(p.merges!.rows[0]).toEqual({ label: 'phantom#7', value: 'Fix it' });
  expect(p.releases!.headline).toBe('2 repos · 1 with unreleased commits');
  expect(p.releases!.rows).toEqual([{ label: 'ashlrai/phantom', value: 'v1.2.0 +3' }, { label: 'ashlrai/site', value: 'no tag' }]);
  expect(p.nodes).toMatchObject({ headline: '1 of 2 ready' });
  expect(p.nodes!.rows[0]).toEqual({ label: 'mbp', value: 'ready · leader' });
  expect(p.agents).toMatchObject({ headline: '2 active claims across 1 agent', rows: [{ label: 'claude', value: '2' }] });
  expect(p.spend).toMatchObject({ headline: '42% of the personal plan used' });
  expect(p.spend!.rows).toEqual([{ label: 'Last hour', value: '1,200 tokens' }, { label: 'claude', value: '1,200 tokens' }]);
});

it('marks feeds that are up but empty as empty', () => {
  const p = by({ runs: { lanes: [], mergesLastHour: { count: 0, items: [] } }, releases: { ...releases, repos: [] },
    nodes: { nodes: [], error: null } as unknown as NodesSnapshot, roster: { schema: 'agent-roster.v1', claims: { items: [] } } });
  expect(Object.values(p).map(x => x.state)).toEqual(['empty', 'empty', 'empty', 'empty', 'empty', 'empty']);
  expect(p.merges!.headline).toBe('No merges in the last hour');
});

it('marks feeds that are down as error, never as zero', () => {
  const p = by({ runs: undefined, releases: null, nodes: null, roster: undefined });
  expect(Object.values(p).map(x => x.state)).toEqual(['error', 'error', 'error', 'error', 'error', 'error']);
  expect(p.fleet!.headline).toBe('Fleet lanes not reported right now');
});

it('surfaces a node inventory error and caps rows', () => {
  const failed = by({ ...live, nodes: { nodes: [], error: 'unreadable' } as unknown as NodesSnapshot });
  expect(failed.nodes).toMatchObject({ state: 'error', headline: 'Node inventory: unreadable' });
  const many = by({ ...live, releases: { ...releases, repos: Array.from({ length: 9 }, (_, i) => ({ repo: `r${i}`, version: '1', latestTag: null })) } as unknown as OpsReleasesV1 });
  expect(many.releases!.rows).toHaveLength(4);
});
