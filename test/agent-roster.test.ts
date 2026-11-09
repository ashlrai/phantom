import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { runAgentsRosterCli } from '../src/cli/agents-roster.js';
import {
  collectAgentRoster,
  validateAgentRoster,
  type AgentRosterDeps,
  type RosterExecResult,
} from '../src/core/fleet/agent-roster.js';
import type { DevinSessionPage } from '../src/core/devin/client.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import { createAgentRosterApi, VERSE_AGENT_ROSTER_PATH } from '../src/core/verse/agent-roster-api.js';
import { acquireCoordination, settleCoordination } from '../src/core/agents/claim-store.js';

const OBSERVED = '2026-11-09T05:00:00.000Z';
// Built at runtime so the source diff does not contain a secret-shaped token.
const SECRET = ['sk', 'EXAMPLE', 'not-a-real-key-value'].join('-');

const phantomSnap: LiveWorkersSnapshot = {
  v: 1,
  generatedAt: OBSERVED,
  sourceState: 'healthy',
  workers: [{ pid: 7, job: 'job-1', repo: 'ashlrai/phantom', lane: 'claude', tier: 'work', ageSeconds: 12 }],
  leaders: [],
  orchestratorAgents: 0,
};

const devinPage: DevinSessionPage = {
  items: [{
    sessionId: 'devin-0123456789abcdef0123456789abcdef',
    orgId: 'org-1',
    userId: 'user-1',
    url: 'https://app.devin.ai/sessions/devin-0123456789abcdef0123456789abcdef',
    status: 'running',
    statusDetail: 'waiting on CI',
    acusConsumed: null,
    pullRequests: [],
    tags: [],
    title: 'Cloud session',
    structuredOutput: null,
  }],
  endCursor: 'cursor-1',
  hasNextPage: true,
};

const claudeJson = JSON.stringify([{
  pid: 4242,
  cwd: '/tmp/roster-cwd-marker',
  kind: 'background',
  startedAt: '2026-11-09T04:00:00.000Z',
  sessionId: 'claude-sess-1',
  name: `Fix the gate ${SECRET}`,
  status: 'waiting',
  waitingFor: 'permission prompt',
}]);

const help: Record<string, string> = {
  'devin list --help': 'List sessions in the current directory. Alias: devin ls\ndevin list --format json\nOutput sessions as JSON\n',
  'codex agents --help': 'codex agents\nOpen the command center to browse chats on a shared server.\n',
  'claude agents --help': 'claude agents --json\nPrint active sessions as a JSON array.\n',
  'cursor-agent ls --help': '',
  'agent --help': 'Cursor Agent\nls  Open previous chats and pick one to resume\n',
  'grok sessions list --help': 'grok sessions list\nList recent sessions for the current directory.\n',
};

function result(stdout: string, extra: Partial<RosterExecResult> = {}): RosterExecResult {
  return { stdout, stderr: '', code: 0, timedOut: false, missing: false, ...extra };
}

function harness(over: AgentRosterDeps = {}, calls: string[] = []): AgentRosterDeps {
  return {
    now: () => Date.parse(OBSERVED),
    timeoutMs: 200,
    listPhantom: async () => phantomSnap,
    listDevinCloud: async () => devinPage,
    readClaims: () => ({
      source: 'available',
      claims: [
        { id: 'job-1', cursor: 1, receivedAt: 1, owner: 'mason', leaseUntil: Date.parse(OBSERVED), completedAt: null },
        { id: 'other-claim', cursor: 2, receivedAt: 1, owner: 'ada', leaseUntil: Date.parse(OBSERVED), completedAt: 2 },
      ],
    }),
    fetchLoopback: async (url) => {
      if (url === 'http://127.0.0.1:11434/api/ps') {
        return { status: 200, body: JSON.stringify({ models: [{ name: 'qwen:72b', model: 'qwen:72b' }] }) };
      }
      if (url === 'http://127.0.0.1:8123/v1/models') {
        return { status: 200, body: JSON.stringify({ object: 'list', data: [{ id: 'local-coder', object: 'model', owned_by: 'omlx' }] }) };
      }
      return { unavailable: true };
    },
    exec: (argv) => {
      const key = argv.join(' ');
      calls.push(key);
      if (key === 'claude agents --json') return Promise.resolve(result(claudeJson));
      if (key === 'cursor-agent ls --help') return Promise.resolve(result('', { code: null, missing: true }));
      const stdout = help[key];
      if (stdout === undefined) return Promise.resolve(result('', { code: null, missing: true }));
      return Promise.resolve(result(stdout));
    },
    ...over,
  };
}

describe('agent roster probes', () => {
  it('lists phantom, devin cloud, claude, ollama and omlx from fixtures and attaches an exact claim', async () => {
    const calls: string[] = [];
    const urls: string[] = [];
    const roster = await collectAgentRoster(harness({
      fetchLoopback: async (url) => {
        urls.push(url);
        return harness().fetchLoopback!(url, 200);
      },
    }, calls));
    expect(validateAgentRoster(roster)).toBeNull();
    expect(roster.sources.map((source) => source.source)).toEqual([
      'phantom', 'devin-cloud', 'devin-desktop', 'codex', 'claude', 'cursor', 'grok', 'ollama', 'omlx',
    ]);
    expect(roster.sessions.map((item) => [item.provider, item.sessionId, item.state])).toEqual([
      ['phantom', 'job-1', 'running'],
      ['devin-cloud', 'devin-0123456789abcdef0123456789abcdef', 'running'],
      ['claude', 'claude-sess-1', 'waiting'],
      ['ollama', 'qwen:72b', 'running'],
      ['omlx', 'local-coder', 'listed'],
    ]);
    const job = roster.sessions.find((item) => item.sessionId === 'job-1');
    expect(job?.claims).toEqual([{ store: 'bus-work', id: 'job-1', owner: 'mason', leaseUntil: OBSERVED, completed: false }]);
    expect(job?.ownership).toBe('claude');
    expect(roster.claims.items.map((item) => item.id)).toEqual(['job-1', 'other-claim']);
    expect(JSON.stringify(roster)).not.toContain('token');

    const cloud = roster.sessions.find((item) => item.provider === 'devin-cloud');
    expect(cloud).toMatchObject({ title: 'Cloud session', ownership: 'user-1', blockers: ['waiting on CI'] });
    expect(roster.sources.find((source) => source.source === 'devin-cloud')).toMatchObject({ availability: 'known', truncated: true });

    const claude = roster.sessions.find((item) => item.provider === 'claude');
    expect(claude?.blockers).toEqual(['permission prompt']);
    expect(claude?.title).toBe('Fix the gate [REDACTED]');
    expect(JSON.stringify(roster)).not.toContain(SECRET);
    expect(JSON.stringify(roster)).not.toContain('/tmp/roster-cwd-marker');

    expect(roster.sources.find((source) => source.source === 'devin-desktop')?.error).toContain('current directory');
    expect(roster.sources.find((source) => source.source === 'codex')?.error).toContain('interactive command center');
    expect(roster.sources.find((source) => source.source === 'cursor')?.error).toContain('interactive chat picker');
    expect(roster.sources.find((source) => source.source === 'grok')?.error).toContain('human table');
    expect(roster.sources.filter((source) => source.availability === 'unknown').every((source) => source.sessions.length === 0)).toBe(true);

    expect(calls).toContain('claude agents --json');
    expect(calls).not.toContain('devin list --format json');
    expect(calls).not.toContain('codex agents');
    expect(calls).not.toContain('grok sessions list');
    expect(calls).not.toContain('cursor-agent ls');
    expect(calls).not.toContain('agent ls');
    expect(urls.sort()).toEqual(['http://127.0.0.1:11434/api/ps', 'http://127.0.0.1:8123/v1/models']);
  });

  it('reads live coordination claims when no claim table is injected', async () => {
    const now = Date.now();
    const acquired = acquireCoordination({
      origin: 'message', key: 'queue:job-1', owner: 'mason', leaseMs: 60_000,
      leaseUntil: now + 60_000, sourceId: 'job-1:1:1', now,
    });
    expect(acquired.status).toBe('acquired');
    try {
      const deps = harness();
      delete deps.readClaims;
      const roster = await collectAgentRoster(deps);
      const job = roster.sessions.find((item) => item.sessionId === 'job-1');
      expect(job?.claims).toContainEqual(expect.objectContaining({ store: 'bus-work', id: 'job-1', owner: 'mason', completed: false }));
      expect(JSON.stringify(roster)).not.toContain(acquired.status === 'acquired' ? acquired.token : 'token');
    } finally {
      if (acquired.status === 'acquired' && acquired.token) {
        settleCoordination({ key: 'queue:job-1', token: acquired.token, outcome: 'released', now });
      }
    }
  });

  it('does not treat a desktop-shaped help text as a session list', async () => {
    const calls: string[] = [];
    const roster = await collectAgentRoster(harness({
      exec: (argv) => {
        const key = argv.join(' ');
        calls.push(key);
        if (key === 'devin list --help') {
          return Promise.resolve(result('List Devin Desktop sessions\ndevin list --format json\n'));
        }
        return harness().exec!(argv, 200);
      },
    }, calls));
    const desktop = roster.sources.find((source) => source.source === 'devin-desktop');
    expect(desktop).toMatchObject({ availability: 'unknown', sessions: [] });
    expect(desktop?.error).toContain('no documented field list');
    expect(calls.filter((call) => call.startsWith('devin '))).toEqual(['devin list --help']);
  });

  it('keeps the rest of the roster when one probe is unknown', async () => {
    const roster = await collectAgentRoster(harness({
      listPhantom: async () => ({ ...phantomSnap, sourceState: 'unavailable', workers: [] }),
      listDevinCloud: async () => ({ unavailable: 'The Devin key is missing from the Keychain. Run `ashlr devin connect` again.' }),
      fetchLoopback: async () => ({ unavailable: true }),
    }));
    expect(roster.sources.find((source) => source.source === 'phantom')).toMatchObject({ availability: 'unknown', error: 'process table unavailable' });
    expect(roster.sources.find((source) => source.source === 'devin-cloud')?.availability).toBe('unknown');
    expect(roster.sources.find((source) => source.source === 'ollama')?.error).toBe('loopback status unavailable');
    expect(roster.sources.find((source) => source.source === 'claude')?.availability).toBe('known');
    expect(validateAgentRoster(roster)).toBeNull();
  });

  it('rejects claude output that is not the documented JSON array', async () => {
    const roster = await collectAgentRoster(harness({
      exec: (argv) => {
        const key = argv.join(' ');
        if (key === 'claude agents --json') return Promise.resolve(result('not json'));
        return harness().exec!(argv, 200);
      },
    }));
    expect(roster.sources.find((source) => source.source === 'claude')).toMatchObject({ availability: 'unknown', error: 'unrecognized output', sessions: [] });
  });

  it('times out a hung probe without failing the roster', async () => {
    const started = Date.now();
    const roster = await collectAgentRoster(harness({
      now: () => Date.now(),
      timeoutMs: 40,
      exec: (argv) => {
        if (argv[0] === 'claude') return new Promise(() => {});
        return harness().exec!(argv, 40);
      },
    }));
    expect(Date.now() - started).toBeLessThan(500);
    expect(roster.latencyMs).toBeLessThan(500);
    expect(roster.sources.find((source) => source.source === 'claude')).toMatchObject({ availability: 'unknown', error: 'timed out' });
    expect(roster.sources.find((source) => source.source === 'phantom')?.availability).toBe('known');
    expect(roster.sources.find((source) => source.source === 'ollama')?.availability).toBe('known');
    expect(validateAgentRoster(roster)).toBeNull();
  });

  it('runs probes in parallel', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const roster = await collectAgentRoster(harness({
      now: () => Date.now(),
      timeoutMs: 1_000,
      exec: async (argv) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 50));
        inFlight -= 1;
        return harness().exec!(argv, 1_000);
      },
    }));
    expect(maxInFlight).toBeGreaterThan(1);
    expect(roster.latencyMs).toBeLessThan(400);
    expect(validateAgentRoster(roster)).toBeNull();
  });

  it('rejects a roster that marks an unknown source as known', async () => {
    const roster = await collectAgentRoster(harness());
    expect(validateAgentRoster(roster)).toBeNull();
    const broken = {
      ...roster,
      sources: roster.sources.map((source) => source.source === 'codex'
        ? { ...source, ok: true, availability: 'unknown' as const, sessions: roster.sessions.slice(0, 1) }
        : source),
    };
    expect(validateAgentRoster(broken)).not.toBeNull();
    expect(validateAgentRoster({ ...roster, schema: 'nope' })).toBe('schema');
  });
});

describe('agents roster command and API', () => {
  it('prints JSON and a human table, and rejects an unknown flag', async () => {
    const json: string[] = [];
    const human: string[] = [];
    const errs: string[] = [];
    expect(await runAgentsRosterCli(['--json'], (line) => json.push(line), (line) => errs.push(line), harness())).toBe(0);
    const parsed = JSON.parse(json.join('\n')) as { schema: string; sources: unknown[] };
    expect(parsed.schema).toBe('agent-roster.v1');
    expect(parsed.sources).toHaveLength(9);
    expect(await runAgentsRosterCli([], (line) => human.push(line), (line) => errs.push(line), harness())).toBe(0);
    expect(human.join('\n')).toContain('job-1');
    expect(human.join('\n')).toContain('devin-desktop');
    expect(await runAgentsRosterCli(['--nope'], () => {}, (line) => errs.push(line), harness())).toBe(2);
    expect(errs.at(-1)).toContain('ashlr agents roster');
    expect(await runAgentsRosterCli(['--json', '--nope'], () => {}, (line) => errs.push(line), harness())).toBe(2);
    expect(errs.at(-1)).toContain('invalid-argument');
  });

  it('serves the roster on the Observe path', async () => {
    const roster = await collectAgentRoster(harness());
    const api = createAgentRosterApi({ collect: async () => roster });
    const ok = capture();
    expect(await api({}, {} as never, ok.res, VERSE_AGENT_ROSTER_PATH, 'GET')).toBe(true);
    expect(ok.status()).toBe(200);
    expect(ok.json()).toMatchObject({ schema: 'agent-roster.v1' });
    const denied = capture();
    expect(await api({}, {} as never, denied.res, VERSE_AGENT_ROSTER_PATH, 'POST')).toBe(true);
    expect(denied.status()).toBe(405);
    expect(await api({}, {} as never, capture().res, '/api/verse/fleet/runs', 'GET')).toBe(false);
  });
});

function capture(): { res: ServerResponse; status: () => number; json: () => unknown } {
  let status = 0;
  let body = '';
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(payload?: string) { body = payload ?? ''; },
  } as unknown as ServerResponse;
  return { res, status: () => status, json: () => JSON.parse(body) as unknown };
}
