import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import { readAgentMessages } from '../src/core/fleet/agent-messages.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { readMapEdges } from '../src/core/fleet/map-edges.js';
import { messageGraphResponse, readMessageGraph } from '../src/core/fleet/message-graph.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('keeps the same durable sender-filtered rows across messages, map edges and organization graph', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-8641-')); roots.push(root);
  const t = Date.UTC(2026, 10, 18, 12), now = t + 60_000;
  expect(registerAgentIdentity({ handle: 'atlas', aliases: ['devin-cloud'] }, { root }).status).toBe('created');
  const rows: [number, string, string, string][] = [
    [t, 'atlas', 'codex', 'RQ-ONE private alpha'],
    [t + 1_000, 'devin-cloud', 'codex', 'RQ-ONE private beta'],
    [t + 2_000, 'codex', 'atlas', 'RQ-ONE recipient only'],
    [t + 3_000, 'atlas', 'claude', 'RQ-TWO other job'],
    [t + 4_000, 'atlas', 'leaders', 'RQ-ONE broadcast'],
    [t + 5_000, 'atlas', 'claude', 'RQ-ONE cutoff'],
    [now + 1_000, 'atlas', 'claude', 'RQ-ONE future'],
  ];
  rows.forEach(([at, from, to, text], i) => expect(appendBusInbox({ id: `m${i}`, from, to, priority: 'P2', ttl: 86_400_000, body: { text } }, { root, now: () => at }).status).toBe('posted'));
  const options = { root, now: () => now };
  const flags = { since: String(t), before: String(t + 5_000), job: 'RQ-ONE', from: 'atlas', excludeFrom: 'codex' };
  const messages = readAgentMessages({ since: t, before: t + 5_000, job: 'RQ-ONE', from: 'atlas', excludeFrom: 'codex', limit: 100 }, options);
  expect(messages.messages.map(row => row.id).sort()).toEqual(['m0', 'm1', 'm4']); // broadcast is gated by the map
  const edges = readMapEdges(flags, options), graph = readMessageGraph(flags, options);
  expect(edges.ok).toBe(true); expect(graph.ok).toBe(true);
  if (!edges.ok || !graph.ok) throw new Error('valid filters rejected');
  expect(edges.result.edges?.map(edge => [edge.id, edge.count]).sort()).toEqual([['atlas->codex', 1], ['devin-cloud->codex', 1]]);
  expect(edges.result.messages).toBe(2);
  const query = new URLSearchParams(flags);
  const response = messageGraphResponse(`/api/fleet/message-graph?${query}`, options);
  expect(response).toEqual({ status: 200, body: graph.result });
  const graphEdges = graph.result.groups!.flatMap(group => group.edges);
  expect(graphEdges.map(edge => [edge.id, edge.count]).sort()).toEqual(edges.result.edges!.map(edge => [edge.id, edge.count]).sort());
  expect([graph.result.messages, graphEdges.reduce((n, edge) => n + edge.count, 0), graph.result.groups!.reduce((n, group) => n + group.count, 0)]).toEqual([2, 2, 2]);
  expect(JSON.stringify(graph.result)).not.toContain('private');
  const later = readMapEdges({ ...flags, before: String(now + 2_000) }, options);
  expect(later.ok && later.result.messages).toBe(3); // cutoff row enters; future row does not
  for (const queryString of ['unknown=x', 'job=RQ-ONE&job=RQ-TWO', 'before=1m&before=2m']) {
    expect(messageGraphResponse(`/api/fleet/message-graph?${queryString}`, options).status).toBe(400);
  }
  writeFileSync(join(root, 'bus-inbox', 'messages.json'), '{broken');
  const unavailable = readMapEdges(flags, options);
  expect(unavailable.ok && unavailable.result).toMatchObject({ source: 'unavailable', edges: null, messages: null });
  expect(messageGraphResponse(`/api/fleet/message-graph?${query}`, options)).toMatchObject({ status: 503, body: { source: 'unavailable', groups: null, messages: null } });
});
