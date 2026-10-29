/**
 * graph-seed — RQ-GRAPH-1B: the fleet's graph.v1 seeder.
 *
 * src/core/fleet/graph-seed.ts builds a `graph.v1` seed document (nodes +
 * edges + issues) from two evidence sources: the fleet.json inventory file
 * (repos / lanes / seat bindings / holds, in fleet-types.ts vocabulary) and
 * the phm seat inventory (the public VerseSeat[] half of discoverSeats).
 *
 * Invariants under test:
 *   1. REFS ONLY — node.refs carries whitelisted identifier scalars only;
 *      a whitelisted ref holding an object/array rejects the record;
 *      unlisted fields (a seat's launcher `command`, `capacity`, …) are
 *      never copied.
 *   2. SECRET-LIKE FIELD NAMES REJECTED — any record carrying a key like
 *      `apiKey`, `client_secret`, `accessToken`, `sshKey` or `env` is
 *      dropped whole with a `secret-field` issue; nothing filters around it.
 *   3. NEVER THROWS — malformed input degrades to a flagged partial seed.
 *   4. Deterministic — nodes/edges sorted by id; same input, same seed.
 *   5. fleet-types vocabulary enforced — lane/stage/enforcement/kind/setBy
 *      enum members only; invalid values reject the record.
 *   6. Edges only between included nodes — a binding to an undeclared lane
 *      or a hold on an undeclared repo records `unresolved-edge`.
 *
 * HOME is relocated to a tmp dir for the IO tests (the suite's homedir()
 * mock follows process.env.HOME). No test touches the real home.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FLEET_GRAPH_SEED_KIND,
  FLEET_GRAPH_SEED_LIMITS,
  buildFleetGraphSeed,
  fleetInventoryPath,
  isSecretLikeFieldName,
  readFleetInventory,
  seedFleetGraph,
  type FleetGraphNodeV1,
} from '../src/core/fleet/graph-seed.js';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const deps = { now: () => NOW };

function seedNodes(seed: ReturnType<typeof buildFleetGraphSeed>): Map<string, FleetGraphNodeV1> {
  return new Map(seed.nodes.map((node) => [node.id, node]));
}

describe('buildFleetGraphSeed — document shape', () => {
  it('seeds an empty graph from no input', () => {
    const seed = buildFleetGraphSeed({}, deps);
    expect(seed.v).toBe(1);
    expect(seed.kind).toBe(FLEET_GRAPH_SEED_KIND);
    expect(seed.kind).toBe('graph.v1');
    expect(seed.generatedAt).toBe(NOW.toISOString());
    expect(seed.complete).toBe(true);
    expect(seed.issues).toEqual([]);
    expect(seed.nodes.map((node) => node.id)).toEqual(['fleet:root']);
    expect(seed.edges).toEqual([]);
    expect(seed.counts).toEqual({ nodes: 1, edges: 0, repos: 0, lanes: 0, seats: 0, holds: 0, rejected: 0 });
    expect(seed.sources.fleetJson.state).toBe('absent');
    expect(seed.sources.seats).toEqual({ state: 'absent', count: 0 });
    expect(seed.limits).toEqual({
      maxNodes: FLEET_GRAPH_SEED_LIMITS.maxNodes,
      maxEdges: FLEET_GRAPH_SEED_LIMITS.maxEdges,
    });
  });

  it('treats a non-object fleet payload as malformed, not a crash', () => {
    for (const fleet of ['nope', 42, null, ['a'], true]) {
      const seed = buildFleetGraphSeed({ fleet }, deps);
      expect(seed.sources.fleetJson.state).toBe('malformed');
      expect(seed.complete).toBe(false);
      expect(seed.issues.some((issue) => issue.code === 'malformed')).toBe(true);
    }
  });

  it('flags a v:2 document but still reads the sections it knows', () => {
    const seed = buildFleetGraphSeed({ fleet: { v: 2, repos: [{ repo: 'ashlrai/phantom' }] } }, deps);
    expect(seed.issues.some((issue) => issue.code === 'bad-version')).toBe(true);
    expect(seedNodes(seed).has('repo:ashlrai/phantom')).toBe(true);
  });

  it('flags a section that is not an array and keeps the others', () => {
    const seed = buildFleetGraphSeed({
      fleet: { v: 1, repos: 'oops', lanes: [{ lane: 'codex' }] },
    }, deps);
    expect(seed.issues.some((issue) => issue.code === 'malformed')).toBe(true);
    expect(seedNodes(seed).has('lane:codex')).toBe(true);
  });

  it('sorts nodes and edges deterministically by id', () => {
    const fleet = {
      v: 1,
      repos: [{ repo: 'ashlrai/zeta' }, { repo: 'ashlrai/alpha' }],
      lanes: [{ lane: 'local' }, { lane: 'codex' }],
    };
    const a = buildFleetGraphSeed({ fleet }, deps);
    const b = buildFleetGraphSeed({ fleet: { v: 1, repos: [...fleet.repos].reverse(), lanes: [...fleet.lanes].reverse() } }, deps);
    expect(a.nodes.map((node) => node.id)).toEqual(b.nodes.map((node) => node.id));
    expect(a.edges.map((edge) => edge.id)).toEqual(b.edges.map((edge) => edge.id));
    expect(a.nodes.map((node) => node.id)).toEqual([...a.nodes.map((node) => node.id)].sort());
  });
});

describe('buildFleetGraphSeed — fleet.json records', () => {
  it('seeds repo / lane / hold nodes and their edges', () => {
    const seed = buildFleetGraphSeed({
      fleet: {
        v: 1,
        repos: [{ repo: 'ashlrai/phantom', stage: 'merge', enforcement: 'server', path: '/abs/checkout' }],
        lanes: [{ lane: 'codex', slots: 2, busy: 0, capReason: null }],
        holds: [{ repo: 'ashlrai/phantom', kind: 'owner-hold', reason: 'waiting on Mason', since: '2026-10-26T00:00:00Z', until: null, setBy: 'mason', landingId: 'l-1' }],
      },
    }, deps);
    expect(seed.complete).toBe(true);
    const nodes = seedNodes(seed);
    const repo = nodes.get('repo:ashlrai/phantom');
    expect(repo).toMatchObject({ kind: 'repo', label: 'ashlrai/phantom', evidence: 'declared', source: 'fleet.json' });
    expect(repo?.refs).toEqual({ repo: 'ashlrai/phantom', stage: 'merge', enforcement: 'server', path: '/abs/checkout' });
    const lane = nodes.get('lane:codex');
    expect(lane?.refs).toEqual({ lane: 'codex', slots: 2, busy: 0 });
    const hold = nodes.get('hold:ashlrai/phantom:owner-hold');
    expect(hold).toMatchObject({ kind: 'hold', evidence: 'declared' });
    expect(hold?.refs['setBy']).toBe('mason');
    expect(hold?.refs['reason']).toBe('waiting on Mason');
    const edgeKinds = (from: string, to: string) =>
      seed.edges.filter((edge) => edge.from === from && edge.to === to).map((edge) => edge.kind);
    expect(edgeKinds('fleet:root', 'repo:ashlrai/phantom')).toEqual(['contains']);
    expect(edgeKinds('fleet:root', 'lane:codex')).toEqual(['contains']);
    expect(edgeKinds('hold:ashlrai/phantom:owner-hold', 'repo:ashlrai/phantom')).toEqual(['holds']);
    expect(seed.counts).toMatchObject({ repos: 1, lanes: 1, holds: 1, rejected: 0 });
  });

  it('never copies unlisted fields into refs', () => {
    const seed = buildFleetGraphSeed({
      fleet: { v: 1, repos: [{ repo: 'ashlrai/phantom', notes: 'internal', detail: { big: 'payload' }, count: 7 }] },
    }, deps);
    const repo = seedNodes(seed).get('repo:ashlrai/phantom');
    expect(repo).toBeDefined();
    expect(repo?.refs).toEqual({ repo: 'ashlrai/phantom' });
  });

  it('rejects a record whose whitelisted ref holds a non-scalar payload', () => {
    const seed = buildFleetGraphSeed({
      fleet: { v: 1, repos: [{ repo: 'ashlrai/phantom', path: { nested: true } }] },
    }, deps);
    expect(seedNodes(seed).has('repo:ashlrai/phantom')).toBe(false);
    expect(seed.issues.some((issue) => issue.code === 'bad-ref')).toBe(true);
    expect(seed.counts.rejected).toBe(1);
  });

  it('rejects invalid enum values and missing required refs', () => {
    const seed = buildFleetGraphSeed({
      fleet: {
        v: 1,
        repos: [{ repo: 'a/b', stage: 'yolo' }, { stage: 'merge' }],
        lanes: [{ lane: 'codexx' }],
        holds: [{ repo: 'a/b' }, { repo: 'a/b', kind: 'nope' }, { repo: 'a/b', kind: 'cooldown', setBy: 'intruder' }],
      },
    }, deps);
    const nodes = seedNodes(seed);
    expect(nodes.has('repo:a/b')).toBe(false);
    expect(nodes.has('lane:codexx')).toBe(false);
    expect([...nodes.keys()].filter((id) => id.startsWith('hold:'))).toEqual([]);
    expect(seed.counts.rejected).toBe(6);
    expect(seed.issues.every((issue) => issue.code === 'bad-ref')).toBe(true);
  });

  it('rejects non-object records as malformed', () => {
    const seed = buildFleetGraphSeed({ fleet: { v: 1, repos: ['ashlrai/phantom', 7, null] } }, deps);
    expect(seed.counts.rejected).toBe(3);
    expect(seed.issues.every((issue) => issue.code === 'malformed')).toBe(true);
  });

  it('rejects unusable ref strings (empty, control chars, over-length)', () => {
    const seed = buildFleetGraphSeed({
      fleet: {
        v: 1,
        repos: [
          { repo: '' },
          { repo: '  spaced  ' },
          { repo: 'a/b' },
          { repo: 'x'.repeat(FLEET_GRAPH_SEED_LIMITS.maxRefChars + 1) },
        ],
      },
    }, deps);
    const nodes = seedNodes(seed);
    expect(nodes.has('repo:a/b')).toBe(true);
    expect(nodes.size).toBe(2); // fleet:root + repo:a/b
    expect(seed.counts.rejected).toBe(3);
  });

  it('keeps the first record on duplicate node identity', () => {
    const seed = buildFleetGraphSeed({
      fleet: { v: 1, repos: [{ repo: 'a/b', stage: 'merge' }, { repo: 'a/b', stage: 'propose' }] },
    }, deps);
    expect(seedNodes(seed).get('repo:a/b')?.refs['stage']).toBe('merge');
    expect(seed.issues.some((issue) => issue.code === 'duplicate-ref')).toBe(true);
  });

  it('records unresolved-edge for bindings and holds with no declared target', () => {
    const seed = buildFleetGraphSeed({
      fleet: {
        v: 1,
        seats: [{ seat: 'ghost', lane: 'codex' }],
        holds: [{ repo: 'ashlrai/ghost', kind: 'cooldown', setBy: 'backpressure', since: '2026-10-26T00:00:00Z' }],
      },
    }, deps);
    const nodes = seedNodes(seed);
    expect(nodes.has('seat:ghost')).toBe(true);
    expect(nodes.has('hold:ashlrai/ghost:cooldown')).toBe(true);
    expect(seed.edges.filter((edge) => edge.kind === 'binds' || edge.kind === 'holds')).toEqual([]);
    expect(seed.issues.filter((issue) => issue.code === 'unresolved-edge')).toHaveLength(2);
  });

  it('caps a section past its record limit', () => {
    const repos = Array.from({ length: FLEET_GRAPH_SEED_LIMITS.maxSectionRecords + 10 }, (_, i) => ({ repo: `o/r${i}` }));
    const seed = buildFleetGraphSeed({ fleet: { v: 1, repos } }, deps);
    expect(seed.issues.some((issue) => issue.code === 'graph-limit')).toBe(true);
    expect(seed.counts.repos).toBe(FLEET_GRAPH_SEED_LIMITS.maxSectionRecords);
  });
});

describe('buildFleetGraphSeed — secret-like field names', () => {
  it('names the obvious shapes', () => {
    for (const name of [
      'apiKey', 'api_key', 'API-KEY', 'clientSecret', 'client_secret',
      'accessToken', 'refresh_token', 'authToken', 'id_token', 'token',
      'password', 'passwd', 'passphrase', 'pwd', 'sshKey', 'privateKey',
      'publicKey', 'session_key', 'signingKey', 'master_key', 'env',
      'bearer', 'cookie', 'oauth', 'jwt', 'pem', 'webhookSecret', 'key', 'pass',
    ]) {
      expect(isSecretLikeFieldName(name), name).toBe(true);
    }
    for (const name of [
      'repo', 'lane', 'seat', 'stage', 'enforcement', 'path', 'reason',
      'since', 'until', 'setBy', 'landingId', 'account', 'model', 'label',
      'slots', 'busy', 'capReason', 'environment', 'monkeying', 'keyboard',
      'id', 'engine', 'health', 'cliVersion', 'costBasis',
    ]) {
      expect(isSecretLikeFieldName(name), name).toBe(false);
    }
  });

  it('rejects any fleet.json record carrying a secret-like name, whatever section', () => {
    const seed = buildFleetGraphSeed({
      fleet: {
        v: 1,
        repos: [{ repo: 'a/b', apiKey: 'x' }, { repo: 'c/d' }],
        lanes: [{ lane: 'codex', client_secret: 'x' }],
        seats: [{ seat: 's1', accessToken: 'x' }],
        holds: [{ repo: 'a/b', kind: 'cooldown', password: 'x' }],
      },
    }, deps);
    const nodes = seedNodes(seed);
    expect(nodes.has('repo:c/d')).toBe(true);
    expect(nodes.has('repo:a/b')).toBe(false);
    expect(nodes.has('lane:codex')).toBe(false);
    expect(nodes.has('seat:s1')).toBe(false);
    expect([...nodes.keys()].filter((id) => id.startsWith('hold:'))).toEqual([]);
    expect(seed.counts.rejected).toBe(4);
    expect(seed.issues.every((issue) => issue.code === 'secret-field')).toBe(true);
    expect(seed.complete).toBe(false);
  });

  it('rejects a phm seat row carrying a secret-like name', () => {
    const seed = buildFleetGraphSeed({
      seats: [
        { id: 'ok', engine: 'codex' },
        { id: 'evil', engine: 'codex', sessionToken: 'x' },
      ],
    }, deps);
    const nodes = seedNodes(seed);
    expect(nodes.has('seat:ok')).toBe(true);
    expect(nodes.has('seat:evil')).toBe(false);
    expect(seed.issues.some((issue) => issue.code === 'secret-field')).toBe(true);
  });

  it('rejects on the NAME alone — a null secret field still rejects the record', () => {
    const seed = buildFleetGraphSeed({ fleet: { v: 1, repos: [{ repo: 'a/b', apiKey: null }] } }, deps);
    expect(seedNodes(seed).has('repo:a/b')).toBe(false);
    expect(seed.issues.some((issue) => issue.code === 'secret-field')).toBe(true);
  });

  it('does not quote the offending value — only the field name and a key digest', () => {
    const seed = buildFleetGraphSeed({ fleet: { v: 1, repos: [{ repo: 'a/b', apiKey: 'SUPERSECRETVALUE' }] } }, deps);
    expect(seed.issues).toHaveLength(1);
    expect(seed.issues[0]!.message).toContain('apiKey');
    expect(JSON.stringify(seed)).not.toContain('SUPERSECRETVALUE');
  });
});

describe('buildFleetGraphSeed — phm seats', () => {
  // The public VerseSeat shape (discoverSeats's `seats` half): no `command`,
  // no `env` — launcher identity lives in the PRIVATE `launches` map, which
  // this builder never sees. Capacity / windows / usage are non-refs.
  const verseSeat = {
    id: 'codex-personal',
    engine: 'codex',
    label: 'Personal Codex',
    accountId: 'acct-1',
    models: [{ id: 'gpt-6.7-codex' }, { id: 'gpt-6.7' }],
    contextWindow: 400_000,
    health: { state: 'ready', summary: 'fine', windows: [{ id: 'w', usedPercent: 3, resetsAt: null }], observedAt: null },
    capacity: { windows: [{ id: 'w' }] },
    lastKnownUsage: { tokens: 100 },
    cliVersion: '1.2.3',
    costBasis: 'subscription',
    notes: ['binary skew'],
  };

  it('seeds seat nodes from the public seat shape — refs only', () => {
    const seed = buildFleetGraphSeed({ seats: [verseSeat] }, deps);
    const seat = seedNodes(seed).get('seat:codex-personal');
    expect(seat).toMatchObject({ kind: 'seat', label: 'Personal Codex', evidence: 'recorded', source: 'phm-seats' });
    expect(seat?.refs).toEqual({
      seat: 'codex-personal',
      engine: 'codex',
      account: 'acct-1',
      label: 'Personal Codex',
      model: 'gpt-6.7-codex',
      health: 'ready',
      cliVersion: '1.2.3',
      costBasis: 'subscription',
    });
  });

  it('rejects a seat row whose env/command payload uses a secret-like name', () => {
    const seed = buildFleetGraphSeed({ seats: [{ id: 's', engine: 'codex', env: { A: '1' } }] }, deps);
    expect(seedNodes(seed).has('seat:s')).toBe(false);
    expect(seed.issues.some((issue) => issue.code === 'secret-field')).toBe(true);
  });

  it('keeps a seat row whose launcher fields are merely non-refs', () => {
    const seed = buildFleetGraphSeed({
      seats: [{ id: 's1', engine: 'claude', command: 'claude-wrapper', args: ['--go'], cwd: '/x' }],
    }, deps);
    const seat = seedNodes(seed).get('seat:s1');
    expect(seat).toBeDefined();
    expect(seat?.refs).toEqual({ seat: 's1', engine: 'claude' });
    expect(seed.complete).toBe(true);
  });

  it('rejects seat rows without a usable id or engine', () => {
    const seed = buildFleetGraphSeed({
      seats: [{ engine: 'codex' }, { id: 'x' }, 'nope', { id: '', engine: '' }],
    }, deps);
    expect([...seedNodes(seed).keys()].filter((id) => id.startsWith('seat:'))).toEqual([]);
    expect(seed.counts.rejected).toBe(4);
  });

  it('maps each seat engine onto its declared dispatch lane (serves)', () => {
    const allLanes = ['local', 'grok-cli', 'claude-cli', 'codex', 'devin-cli'] as const;
    const seed = buildFleetGraphSeed({
      fleet: { v: 1, lanes: allLanes.map((lane) => ({ lane })) },
      seats: [
        { id: 'c1', engine: 'claude' },
        { id: 'x1', engine: 'codex' },
        { id: 'g1', engine: 'grok' },
        { id: 'l1', engine: 'local' },
        { id: 'd1', engine: 'devin' },
      ],
    }, deps);
    const served = new Set(seed.edges.filter((edge) => edge.kind === 'serves').map((edge) => `${edge.from}→${edge.to}`));
    expect(served).toEqual(new Set([
      'seat:c1→lane:claude-cli',
      'seat:x1→lane:codex',
      'seat:g1→lane:grok-cli',
      'seat:l1→lane:local',
      'seat:d1→lane:devin-cli',
    ]));
  });

  it('adds no serves edge to a lane fleet.json does not declare', () => {
    const seed = buildFleetGraphSeed({
      fleet: { v: 1, lanes: [{ lane: 'codex' }] },
      seats: [{ id: 'c1', engine: 'claude' }, { id: 'x1', engine: 'codex' }],
    }, deps);
    const serves = seed.edges.filter((edge) => edge.kind === 'serves');
    expect(serves).toHaveLength(1);
    expect(serves[0]).toMatchObject({ from: 'seat:x1', to: 'lane:codex' });
    // An undeclared lane is not an inconsistency — the seat exists regardless.
    expect(seed.complete).toBe(true);
  });

  it('merges a declared binding with its discovered seat (source both)', () => {
    const seed = buildFleetGraphSeed({
      fleet: { v: 1, lanes: [{ lane: 'codex' }], seats: [{ seat: 'codex-personal', lane: 'codex' }] },
      seats: [{ id: 'codex-personal', engine: 'codex', accountId: 'acct-1' }],
    }, deps);
    const seat = seedNodes(seed).get('seat:codex-personal');
    expect(seat).toMatchObject({ source: 'both', evidence: 'recorded' });
    expect(seat?.refs['lane']).toBe('codex');
    expect(seat?.refs['account']).toBe('acct-1');
    expect(seed.edges.filter((edge) => edge.kind === 'binds')).toHaveLength(1);
    expect(seed.edges.some((edge) => edge.kind === 'serves' && edge.from === 'seat:codex-personal')).toBe(true);
    expect(seed.counts.seats).toBe(1);
  });

  it('seeds a declared-only seat as declared evidence with its binds edge', () => {
    const seed = buildFleetGraphSeed({
      fleet: { v: 1, lanes: [{ lane: 'codex' }], seats: [{ seat: 'reserve', lane: 'codex' }] },
    }, deps);
    const seat = seedNodes(seed).get('seat:reserve');
    expect(seat).toMatchObject({ source: 'fleet.json', evidence: 'declared' });
    expect(seed.edges.filter((edge) => edge.kind === 'binds')).toHaveLength(1);
  });
});

describe('readFleetInventory / fleetInventoryPath', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevAshlrHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-graph-seed-'));
    prevHome = process.env['HOME'];
    prevAshlrHome = process.env['ASHLR_HOME'];
    process.env['HOME'] = tmpHome;
    process.env['USERPROFILE'] = tmpHome;
    delete process.env['ASHLR_HOME'];
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    if (prevAshlrHome === undefined) delete process.env['ASHLR_HOME'];
    else process.env['ASHLR_HOME'] = prevAshlrHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('resolves under ~/.ashlr/fleet/fleet.json and honors ASHLR_HOME', () => {
    expect(fleetInventoryPath()).toBe(join(tmpHome, '.ashlr', 'fleet', 'fleet.json'));
    process.env['ASHLR_HOME'] = join(tmpHome, 'elsewhere');
    expect(fleetInventoryPath()).toBe(join(tmpHome, 'elsewhere', 'fleet', 'fleet.json'));
    process.env['ASHLR_HOME'] = 'relative/path';
    expect(fleetInventoryPath()).toBe(join(tmpHome, '.ashlr', 'fleet', 'fleet.json'));
  });

  it('reports missing / malformed / valid distinctly', () => {
    const path = join(tmpHome, 'fleet.json');
    expect(readFleetInventory(path)).toMatchObject({ ok: false, reason: 'missing' });
    writeFileSync(path, '{not json');
    expect(readFleetInventory(path)).toMatchObject({ ok: false, reason: 'malformed' });
    writeFileSync(path, JSON.stringify({ v: 1, repos: [{ repo: 'a/b' }] }));
    const read = readFleetInventory(path);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.inventory).toEqual({ v: 1, repos: [{ repo: 'a/b' }] });
  });

  it('refuses a file past the byte cap', () => {
    const path = join(tmpHome, 'fleet.json');
    writeFileSync(path, ' '.repeat(FLEET_GRAPH_SEED_LIMITS.maxFileBytes + 1));
    expect(readFleetInventory(path)).toMatchObject({ ok: false, reason: 'too-large' });
  });
});

describe('seedFleetGraph — end to end', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevAshlrHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-graph-seed-e2e-'));
    prevHome = process.env['HOME'];
    prevAshlrHome = process.env['ASHLR_HOME'];
    process.env['HOME'] = tmpHome;
    process.env['USERPROFILE'] = tmpHome;
    delete process.env['ASHLR_HOME'];
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    if (prevAshlrHome === undefined) delete process.env['ASHLR_HOME'];
    else process.env['ASHLR_HOME'] = prevAshlrHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('seeds from the on-disk fleet.json plus the injected seat list', async () => {
    mkdirSync(join(tmpHome, '.ashlr', 'fleet'), { recursive: true });
    writeFileSync(
      join(tmpHome, '.ashlr', 'fleet', 'fleet.json'),
      JSON.stringify({
        v: 1,
        repos: [{ repo: 'ashlrai/phantom', stage: 'merge' }],
        lanes: [{ lane: 'codex', slots: 2 }],
        seats: [{ seat: 'codex-personal', lane: 'codex' }],
      }),
    );
    const seed = await seedFleetGraph({
      now: () => NOW,
      listSeats: () => [{ id: 'codex-personal', engine: 'codex', label: 'Personal Codex' }],
    });
    expect(seed.sources.fleetJson).toEqual({ state: 'loaded', path: join(tmpHome, '.ashlr', 'fleet', 'fleet.json') });
    expect(seed.sources.seats).toEqual({ state: 'loaded', count: 1 });
    expect(seed.complete).toBe(true);
    const seat = seedNodes(seed).get('seat:codex-personal');
    expect(seat).toMatchObject({ source: 'both', evidence: 'recorded' });
    expect(seedNodes(seed).has('repo:ashlrai/phantom')).toBe(true);
    expect(seed.edges.some((edge) => edge.kind === 'binds')).toBe(true);
  });

  it('treats a missing fleet.json as the designed empty state', async () => {
    const seed = await seedFleetGraph({ now: () => NOW, listSeats: () => [] });
    expect(seed.sources.fleetJson.state).toBe('absent');
    expect(seed.sources.seats).toEqual({ state: 'loaded', count: 0 });
    expect(seed.complete).toBe(true);
    expect(seed.nodes.map((node) => node.id)).toEqual(['fleet:root']);
  });

  it('flags an unreadable fleet.json and still seeds the seats', async () => {
    mkdirSync(join(tmpHome, '.ashlr', 'fleet'), { recursive: true });
    writeFileSync(join(tmpHome, '.ashlr', 'fleet', 'fleet.json'), '{broken');
    const seed = await seedFleetGraph({ now: () => NOW, seats: [{ id: 's1', engine: 'local' }] });
    expect(seed.sources.fleetJson.state).toBe('malformed');
    expect(seed.complete).toBe(false);
    expect(seed.issues.some((issue) => issue.code === 'malformed')).toBe(true);
    expect(seedNodes(seed).has('seat:s1')).toBe(true);
  });

  it('survives a seat source that throws', async () => {
    const seed = await seedFleetGraph({
      now: () => NOW,
      listSeats: () => { throw new Error('discovery blew up'); },
    });
    expect(seed.sources.seats).toEqual({ state: 'absent', count: 0 });
    expect(seed.nodes.map((node) => node.id)).toEqual(['fleet:root']);
  });
});
