import { expect, it, vi, afterEach } from 'vitest';
import { agentChoices, routeRows, routesHeadline } from './agent-routes-model.js';
import { agentRoutesQuery, narrowAgentRoutes } from './agent-routes-query.js';
import type { GraphLiveData } from './graph-live-queries.js';

const live = (state: 'ready' | 'held') => ({ state, usedPercent: null, resetsAtMs: null, readingAgeMs: null, stale: false, reasons: [] });
const data = { v: 1 as const, live: { nodes: [
  { id: 'agent:fake%2Fleader', kind: 'agent', agentId: 'fake/leader', live: live('ready') },
  { id: 'model:fake', kind: 'model', live: live('held') },
  { id: 'mcp:fake', kind: 'mcp', live: live('ready') },
] } };
const edge = (to: string) => ({ id: `edge:${to}`, kind: 'routes-to' as const, from: 'agent:fake%2Fleader', to, source: 'fleet' as const });
const response = { ...data, scope: { kind: 'agent' as const, agentId: 'fake/leader' }, edges: [edge('model:fake'), edge('mcp:fake'), edge('missing')] };

afterEach(() => vi.unstubAllGlobals());

it('uses agent identifiers and joins each direct edge to its live resource', () => {
  expect(agentChoices(data as GraphLiveData)).toEqual([{ id: 'fake/leader', label: 'fake/leader' }]);
  const reply = narrowAgentRoutes(response, 'fake/leader')!;
  const rows = routeRows(reply, 0);
  expect(rows).toEqual([
    { resourceId: 'model:fake', kind: 'model', label: 'model:fake', state: 'held', edgeLabel: 'routes to', stateText: 'held · unmeasured · reset unknown · no dated reading' },
    { resourceId: 'mcp:fake', kind: 'mcp', label: 'mcp:fake', state: 'ready', edgeLabel: 'routes to', stateText: 'ready · unmeasured · reset unknown · no dated reading' },
    { resourceId: 'missing', kind: 'unknown', label: 'missing', state: 'untracked', edgeLabel: 'routes to', stateText: 'untracked' },
  ]);
  expect(routesHeadline('fake/leader', rows)).toBe('fake/leader reaches 3 resources · 1 held');
  expect(routesHeadline('fake/leader', rows.slice(0, 1))).toBe('fake/leader reaches 1 resource · 1 held');
  expect(routesHeadline('fake/leader', [])).toBe('fake/leader reaches 0 resources');
});

it('rejects missing or malformed scoped responses', () => {
  expect(narrowAgentRoutes(data, 'fake/leader')).toBeNull();
  expect(narrowAgentRoutes(response, 'other')).toBeNull();
  expect(narrowAgentRoutes({ ...response, edges: [{ ...edge('x'), kind: 'reviews' }] }, 'fake/leader')).toBeNull();
  expect(narrowAgentRoutes({ ...response, live: { nodes: [{}] } }, 'fake/leader')).toBeNull();
});

it('encodes the id and refuses invalid ids before issuing a request', async () => {
  const fetcher = vi.fn(async (_url: string) => Response.json(response));
  vi.stubGlobal('fetch', fetcher);
  const query = agentRoutesQuery('fake/leader');
  expect(query.key).toBe('verse-fleet-graph-agent:fake/leader');
  expect(await query.fetch()).toMatchObject({ scope: response.scope, edges: response.edges });
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/verse/fleet/graph/live?agent=fake%2Fleader');
  for (const id of ['', ' fake', 'x&agent=y', 'x'.repeat(257), 'x\n']) {
    await expect(agentRoutesQuery(id).fetch()).rejects.toThrow('Invalid agent identifier.');
  }
  expect(fetcher).toHaveBeenCalledTimes(1);
});
