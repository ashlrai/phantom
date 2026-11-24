/**
 * fleet_agent_roster: the unified live session roster over the isolated
 * fleet MCP server — the same collectAgentRoster projection `phm agents
 * roster` and the native `phm_agent_roster` tool serve. Every other
 * fleet_agent_* read answers a bus question; this is the presence read —
 * which agent sessions are actually running across Phantom, Devin cloud and
 * desktop, Codex, Claude, Cursor, Grok, Ollama and oMLX, and what each holds.
 *
 * Hermetic: injected readers and injected AgentRosterDeps, in-memory MCP
 * transports; the real-projection test runs collectAgentRoster against
 * injected probes, never the real process table, CLIs, loopback or home.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import { parseFleetAgentRosterArgs, readFleetAgentRoster } from '../src/mcp/fleet-agent-roster.js';
import {
  collectAgentRoster, ROSTER_SOURCES, validateAgentRoster,
  type AgentRoster, type AgentRosterDeps, type RosterExecResult, type RosterSession, type RosterSource, type RosterSourceId,
} from '../src/core/fleet/agent-roster.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const connections: Client[] = [];
const OBSERVED = '2026-11-18T12:00:00.000Z';

const phantomSnap: LiveWorkersSnapshot = {
  v: 1,
  generatedAt: OBSERVED,
  sourceState: 'healthy',
  workers: [{ pid: 7, job: 'job-1', repo: 'ashlrai/phantom', lane: 'claude', tier: 'work', ageSeconds: 12 }],
  leaders: [],
  orchestratorAgents: 0,
};

function session(provider: RosterSourceId, over: Partial<RosterSession> = {}): RosterSession {
  return {
    provider, sessionId: `${provider}-sess-1`, title: 'A session', state: 'running',
    ownership: null, claims: [], lastActivity: OBSERVED, blockers: [], ...over,
  };
}

function source(id: RosterSourceId, sessions: RosterSession[] = [], over: Partial<RosterSource> = {}): RosterSource {
  return {
    source: id, ok: sessions.length > 0 || over.ok === true, availability: 'known',
    sessions, error: null, observedAt: OBSERVED, truncated: false, ...over,
  };
}

function rosterFixture(): AgentRoster {
  const phantomSession = session('phantom', { sessionId: 'job-1', title: 'ashlrai/phantom', ownership: 'claude' });
  const claudeSession = session('claude', { sessionId: 'claude-sess-1', title: 'Fix the gate', state: 'waiting', blockers: ['permission prompt'] });
  const sources: RosterSource[] = ROSTER_SOURCES.map((id) => {
    if (id === 'phantom') return source(id, [phantomSession]);
    if (id === 'claude') return source(id, [claudeSession]);
    return {
      source: id, ok: false, availability: 'unknown', sessions: [],
      error: 'probe unavailable', observedAt: OBSERVED, truncated: false,
    };
  });
  return {
    schema: 'agent-roster.v1', observedAt: OBSERVED, latencyMs: 42,
    sources,
    sessions: [phantomSession, claudeSession],
    claims: { source: 'missing', items: [] },
  };
}

async function connect(readers: FleetReaders = {
  status: async () => ({}),
  loop: async () => ({}),
}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer(readers);
  const client = new Client({ name: 'agent-roster-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callAgentRoster(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_agent_roster', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
});

describe('fleet_agent_roster argument parsing', () => {
  it('accepts only an empty argument object — every probe target and store root stays server-owned', async () => {
    expect(parseFleetAgentRosterArgs({})).toEqual({});
    for (const bad of [
      { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' }, { home: '/tmp' },
      { provider: 'claude' }, { limit: 1 }, { extra: 1 }, { agent: 'x' }, { timeoutMs: 1 },
    ]) expect(parseFleetAgentRosterArgs(bad)).toBeNull();
  });
});

describe('fleet_agent_roster reader', () => {
  it('runs the shared roster and spreads its sources and sessions beside the envelope', async () => {
    const roster = rosterFixture();
    const seen: unknown[][] = [];
    const read = async () => {
      seen.push([]);
      return roster;
    };
    const result = await readFleetAgentRoster({ roster: read });
    expect(seen).toEqual([[]]);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'live-observation', authority: 'none',
      schema: 'agent-roster.v1', observedAt: OBSERVED, latencyMs: 42,
      claims: { source: 'missing', items: [] },
    });
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((result.sources as RosterSource[]).map(s => s.source)).toEqual([...ROSTER_SOURCES]);
    expect((result.sessions as RosterSession[]).map(s => s.provider)).toEqual(['phantom', 'claude']);
    expect(validateAgentRoster(result)).toBeNull();
  });

  it('reports a throwing roster read as unavailable — never an invented roster', async () => {
    const result = await readFleetAgentRoster({
      roster: async () => { throw new Error('probe exploded'); },
    });
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'live-observation', authority: 'none',
      status: 'unavailable', reason: 'agent-roster-unreadable',
    });
    expect('sessions' in result).toBe(false);
    expect('sources' in result).toBe(false);
  });

  it('serves the real collectAgentRoster projection with per-source honesty', async () => {
    const missingExec: RosterExecResult = { stdout: '', stderr: '', code: null, timedOut: false, missing: true };
    const deps: AgentRosterDeps = {
      now: () => Date.parse(OBSERVED),
      timeoutMs: 50,
      listPhantom: async () => phantomSnap,
      listDevinCloud: async () => ({ unavailable: 'no devin credentials' }),
      readDevinCliRoster: async () => null,
      readClaims: () => ({ source: 'missing', claims: [] }),
      exec: async () => missingExec,
      fetchLoopback: async () => ({ unavailable: true }),
    };
    const result = await readFleetAgentRoster({ roster: () => collectAgentRoster(deps) });
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'live-observation', authority: 'none',
      schema: 'agent-roster.v1', observedAt: OBSERVED,
      claims: { source: 'missing', items: [] },
    });
    const roster = result as AgentRoster;
    expect(validateAgentRoster(roster)).toBeNull();
    const bySource = new Map(roster.sources.map(s => [s.source, s]));
    // The injected healthy phantom snapshot is the one known source; every
    // missing/failed probe degrades to unknown with a reason, never zero sessions as fact.
    expect(bySource.get('phantom')).toMatchObject({ availability: 'known', ok: true });
    expect(bySource.get('phantom')!.sessions.map(s => s.sessionId)).toEqual(['job-1']);
    for (const id of ['devin-cloud', 'devin-desktop', 'codex', 'claude', 'cursor', 'grok', 'ollama', 'omlx'] as const) {
      expect(bySource.get(id)).toMatchObject({ availability: 'unknown', ok: false, sessions: [] });
      expect(bySource.get(id)!.error).toBeTruthy();
    }
  });
});

describe('fleet_agent_roster MCP tool', () => {
  it('is advertised read-only beside the agent reads with an empty argument schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_agent_roster');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.description).toContain('collectAgentRoster');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
  });

  it.each([
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ cwd: '/tmp' }],
    [{ home: '/tmp' }], [{ provider: 'claude' }], [{ limit: 5 }], [{ extra: 1 }], [{ timeoutMs: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const agentRoster = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentRoster });
    await expect(client.callTool({ name: 'fleet_agent_roster', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(agentRoster).not.toHaveBeenCalled();
  });

  it('calls the injected reader with no arguments and returns its projection', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'live-observation', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      ...rosterFixture(),
    };
    const agentRoster = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentRoster });
    const { parsed } = await callAgentRoster(client, {});
    expect(agentRoster).toHaveBeenCalledWith();
    expect(parsed).toEqual(payload);
    const sessions = parsed.sessions as RosterSession[];
    expect(sessions.map(s => s.provider)).toEqual(['phantom', 'claude']);
  });

  it('accepts an omitted arguments object', async () => {
    const agentRoster = vi.fn(async () => ({ ok: true }));
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentRoster });
    const { parsed } = await callAgentRoster(client);
    expect(agentRoster).toHaveBeenCalledWith();
    expect(parsed).toEqual({ ok: true });
  });

  it('keeps a throwing injected reader behind the sanitized fleet error', async () => {
    const client = await connect({
      status: async () => ({}), loop: async () => ({}),
      agentRoster: async () => { throw new Error('secret-shaped detail'); },
    });
    const result = await client.callTool({ name: 'fleet_agent_roster', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBe(true);
    expect(content[0]!.text).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
  });

  it('documents the tool in the MCP catalog', () => {
    const md = readFileSync(new URL('../docs/MCP-TOOLS.md', import.meta.url), 'utf8');
    expect(md).toMatch(/^\| phantom-fleet \| `fleet_agent_roster` \|/m);
  });
});
