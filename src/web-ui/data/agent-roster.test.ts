import { describe, expect, it } from 'vitest';
import type { VerseSeat } from '../../core/verse/types.js';
import {
  AVATAR_SHAPES,
  PINNED_SECTION,
  ROSTER_COLORS,
  UNASSIGNED_TEAM,
  buildAgentRoster,
  defaultAvatar,
  initialsOf,
  parseRosterPreferences,
  readFleetRoster,
  resolvePool,
  rosterSections,
  type RosterAgent,
} from './agent-roster.js';
import {
  FLEET_V1_FIXTURE,
  FLEET_V1_UNKNOWN_AGENTS_FIXTURE,
  PREFERENCES_FIXTURE,
  ROSTER_FIXTURE_NOW,
  SEATS_FIXTURE,
} from './agent-roster.fixtures.js';

const now = ROSTER_FIXTURE_NOW;

function byId(agents: readonly RosterAgent[], id: string): RosterAgent {
  const agent = agents.find((a) => a.id === id);
  if (!agent) throw new Error(`no agent ${id}`);
  return agent;
}

describe('readFleetRoster', () => {
  it('rejects anything that is not a fleet.v1 document', () => {
    expect(() => readFleetRoster(null, now)).toThrow('Not a fleet.v1 snapshot.');
    expect(() => readFleetRoster([], now)).toThrow();
    expect(() => readFleetRoster({ ...FLEET_V1_FIXTURE, schema: 'fleet.v2' }, now)).toThrow();
    expect(() => readFleetRoster({ ...FLEET_V1_FIXTURE, generated_at: 'yesterday' }, now)).toThrow();
  });

  it('groups claims per agent and drops expired claims', () => {
    const fleet = readFleetRoster(FLEET_V1_FIXTURE, now);
    expect(fleet.agents?.get('codex-cmp')).toEqual([
      { repo: 'ashlrai/phantom', task: 'Review fleet evidence', expiresAt: '2026-10-26T13:00:00.000Z' },
      { repo: 'ashlrai/locus', task: 'Tighten seat probe', expiresAt: '2026-10-26T14:00:00.000Z' },
    ]);
    expect(fleet.agents?.has('codex-personal')).toBe(false);
    expect(fleet.agents?.get('claude')).toEqual([]);
  });

  it('keeps agents: null as unknown rather than an empty roster', () => {
    expect(readFleetRoster(FLEET_V1_UNKNOWN_AGENTS_FIXTURE, now).agents).toBeNull();
  });

  it('skips malformed rows and non-canonical pools without failing the document', () => {
    const fleet = readFleetRoster({
      ...FLEET_V1_FIXTURE,
      agents: [7, { agent: '' }, { agent: '../etc/passwd' }, { agent: 'x'.repeat(200) }, { agent: 'devin', repo: 'not a repo', task: 42, claim_id: 'c', expires_at: '2026-10-26T12:30:00Z' }],
      pools: [{ id: 'codex-cmp' }, { id: 'codex-cmp' }, { id: 'gpt-9' }, { id: 'cursor', shared_with: 'nowhere' }],
    }, now);
    expect([...(fleet.agents?.keys() ?? [])]).toEqual(['devin']);
    expect(fleet.agents?.get('devin')).toEqual([{ repo: null, task: null, expiresAt: '2026-10-26T12:30:00.000Z' }]);
    expect(fleet.pools).toEqual([
      { id: 'codex-cmp', label: 'Codex (primary)', sharedWith: null },
      { id: 'cursor', label: 'Cursor', sharedWith: null },
    ]);
  });

  it('bounds rows per document and claims per agent', () => {
    const rows = Array.from({ length: 1_500 }, (_, i) => ({ agent: `ag_${String(i).padStart(8, '0')}`, claim_id: null, expires_at: null }));
    expect(readFleetRoster({ ...FLEET_V1_FIXTURE, agents: rows }, now).agents?.size).toBe(1_000);
    const claims = Array.from({ length: 80 }, (_, i) => ({ agent: 'devin', repo: 'ashlrai/phantom', task: `t${i}`, claim_id: `c${i}`, expires_at: '2026-10-27T00:00:00Z' }));
    expect(readFleetRoster({ ...FLEET_V1_FIXTURE, agents: claims }, now).agents?.get('devin')).toHaveLength(50);
  });
});

describe('resolvePool', () => {
  it('maps canonical ids and the scheduler aliases fleet.v1 documents', () => {
    expect(resolvePool('codex-cmp')).toBe('codex-cmp');
    expect(resolvePool('codex-primary')).toBe('codex-cmp');
    expect(resolvePool('codex-secondary')).toBe('codex-personal');
    expect(resolvePool('claude')).toBe('claude-max');
    expect(resolvePool('local')).toBe('omlx');
    expect(resolvePool('ag_k3m9x2p7q4')).toBeNull();
    expect(resolvePool('__proto__')).toBeNull();
    expect(resolvePool(3)).toBeNull();
  });
});

describe('parseRosterPreferences', () => {
  it('keeps valid fields and drops bad ones one at a time', () => {
    const prefs = parseRosterPreferences(PREFERENCES_FIXTURE);
    expect(prefs.claude).toEqual({ notify: false });
    expect(prefs['codex-cmp']).toEqual({ pinned: true, color: 'violet', shape: 'hexagon', labelColor: 'teal' });
    expect(prefs.ag_k3m9x2p7q4).toEqual({ name: 'Docs sweeper', pool: 'claude-max' });
  });

  it('accepts pool: null as an explicit hand-back to the router', () => {
    expect(parseRosterPreferences({ devin: { pool: null } }).devin).toEqual({ pool: null });
  });

  it('refuses a team that would merge into the Pinned section, and bad ids', () => {
    expect(parseRosterPreferences({ devin: { team: ' pinned ' } }).devin).toEqual({});
    expect(parseRosterPreferences({ 'bad id': { pinned: true } })).toEqual({});
    expect(parseRosterPreferences('nope')).toEqual({});
    expect(parseRosterPreferences(null)).toEqual({});
  });

  it('folds control characters and bounds names', () => {
    const prefs = parseRosterPreferences({ devin: { name: `  Dev\u0000in\n${'x'.repeat(100)}` } });
    expect(prefs.devin?.name).toMatch(/^Dev in x+…$/);
    expect(prefs.devin?.name).toHaveLength(48);
  });
});

describe('defaults', () => {
  it('derives a stable avatar from the id alone', () => {
    const a = defaultAvatar('ag_k3m9x2p7q4', 'Docs sweeper');
    expect(defaultAvatar('ag_k3m9x2p7q4', 'Docs sweeper')).toEqual(a);
    expect(ROSTER_COLORS).toContain(a.color);
    expect(AVATAR_SHAPES).toContain(a.shape);
    expect(a.initials).toBe('DS');
    const looks = new Set(['codex-cmp', 'codex-personal', 'claude', 'cursor', 'devin', 'local', 'omlx', 'grok-build'].map((id) => {
      const v = defaultAvatar(id, id);
      return `${v.color}/${v.shape}`;
    }));
    expect(looks.size).toBeGreaterThan(4);
  });

  it('makes initials from words or the first two letters', () => {
    expect(initialsOf('Claude Code')).toBe('CC');
    expect(initialsOf('codex-cmp')).toBe('CC');
    expect(initialsOf('Devin')).toBe('DE');
    expect(initialsOf('Ölmez build')).toBe('ÖB');
    expect(initialsOf('—')).toBe('?');
  });
});

describe('buildAgentRoster', () => {
  const roster = buildAgentRoster({ fleet: FLEET_V1_FIXTURE, seats: SEATS_FIXTURE, preferences: PREFERENCES_FIXTURE, now });

  it('lists exactly the live fleet.v1 agents, sorted by name', () => {
    expect(roster.schema).toBe('fleet.v1');
    expect(roster.generatedAt).toBe('2026-10-26T12:00:00.000Z');
    expect(roster.state).toBe('known');
    expect(roster.agents.map((a) => [a.id, a.name])).toEqual([
      ['claude', 'Claude Code'],
      ['codex-cmp', 'CMP Codex'],
      ['cursor', 'Cursor (UI)'],
      ['ag_k3m9x2p7q4', 'Docs sweeper'],
      ['local', 'oMLX (local)'],
    ]);
    expect(roster.pools.map((p) => p.id)).toEqual(['grok-ultra-weekly', 'codex-cmp', 'codex-personal', 'claude-max', 'devin', 'grok-build', 'cursor', 'omlx']);
    expect(roster.pools.find((p) => p.id === 'cursor')?.sharedWith).toBe('grok-ultra-weekly');
  });

  it('applies preferences over the defaults', () => {
    const cmp = byId(roster.agents, 'codex-cmp');
    expect(cmp).toMatchObject({
      avatar: { color: 'violet', shape: 'hexagon', initials: 'CC' },
      labelColor: 'teal',
      team: 'Codex',
      pinned: true,
      hidden: false,
      notify: true,
      pool: 'codex-cmp',
      poolLabel: 'Codex (primary)',
    });
    expect(cmp.claims).toHaveLength(2);
    expect(byId(roster.agents, 'cursor')).toMatchObject({ team: 'Design', notify: false, pool: 'cursor', seat: null });
    expect(byId(roster.agents, 'local').hidden).toBe(true);
    const claude = byId(roster.agents, 'claude');
    expect(claude).toMatchObject({ notify: false, pinned: false, pool: 'claude-max', team: 'Claude' });
    expect(claude.labelColor).toBe(claude.avatar.color);
  });

  it('takes per-agent detail from the matching seat', () => {
    expect(byId(roster.agents, 'claude').seat).toEqual({ seatId: 'claude', label: 'Claude Code', engine: 'claude', modelLabel: 'Opus 5.5', disabled: null });
    // An `ag_` agent has no seat of its own; its chosen pool's seat describes it.
    expect(byId(roster.agents, 'ag_k3m9x2p7q4')).toMatchObject({ pool: 'claude-max', team: 'Claude', seat: { seatId: 'claude' } });
    // Any local seat backs the oMLX pool.
    expect(byId(roster.agents, 'local')).toMatchObject({ pool: 'omlx', team: 'Local', seat: { seatId: 'local:qwen3-coder', engine: 'local' } });
  });

  it('carries a seat that cannot run with its reason', () => {
    const r = buildAgentRoster({ fleet: { ...FLEET_V1_FIXTURE, agents: [{ agent: 'devin', claim_id: null }] }, seats: SEATS_FIXTURE, now });
    expect(r.agents[0]?.seat).toMatchObject({ seatId: 'devin', disabled: 'Devin is signed out.' });
  });

  it('leaves the pool to the router for an unknown agent with no seat or preference', () => {
    const r = buildAgentRoster({ fleet: { ...FLEET_V1_FIXTURE, agents: [{ agent: 'ag_zzzzzzzz', claim_id: null }] }, now });
    expect(r.agents[0]).toMatchObject({ id: 'ag_zzzzzzzz', name: 'ag_zzzzzzzz', pool: null, poolLabel: null, team: UNASSIGNED_TEAM, seat: null, notify: true });
  });

  it('honours pool: null over an agent id that names a pool', () => {
    const r = buildAgentRoster({ fleet: FLEET_V1_FIXTURE, seats: SEATS_FIXTURE, preferences: { cursor: { pool: null } }, now });
    expect(byId(r.agents, 'cursor')).toMatchObject({ pool: null, poolLabel: null, team: UNASSIGNED_TEAM });
  });

  it('works without seats or preferences', () => {
    const r = buildAgentRoster({ fleet: FLEET_V1_FIXTURE, now });
    expect(byId(r.agents, 'claude')).toMatchObject({ name: 'Claude Max', seat: null, pinned: false, hidden: false, notify: true });
  });

  it('reports unknown agents as unknown, with no rows', () => {
    const r = buildAgentRoster({ fleet: FLEET_V1_UNKNOWN_AGENTS_FIXTURE, seats: SEATS_FIXTURE, now });
    expect(r.state).toBe('unknown');
    expect(r.agents).toEqual([]);
  });

  it('never adds an agent from preferences or seats alone', () => {
    const r = buildAgentRoster({ fleet: { ...FLEET_V1_FIXTURE, agents: [] }, seats: SEATS_FIXTURE, preferences: { devin: { pinned: true } }, now });
    expect(r.state).toBe('known');
    expect(r.agents).toEqual([]);
  });

  it('does not mutate its inputs', () => {
    const fleet = structuredClone(FLEET_V1_FIXTURE);
    const seats = structuredClone(SEATS_FIXTURE);
    const prefs = structuredClone(PREFERENCES_FIXTURE);
    buildAgentRoster({ fleet, seats, preferences: prefs, now });
    expect(fleet).toEqual(FLEET_V1_FIXTURE);
    expect(seats).toEqual(SEATS_FIXTURE);
    expect(prefs).toEqual(PREFERENCES_FIXTURE);
  });
});

describe('redaction', () => {
  // Built at runtime so no credential-shaped literal sits in the repository.
  const ghToken = ['ghp', 'Q'.repeat(36)].join('_');
  const apiKey = ['sk', 'ant', 'api03', 'Z'.repeat(40)].join('-');
  const lease = `lease_${'L'.repeat(24)}`;
  const capability = `cap_${'C'.repeat(24)}`;
  const accountSecret = `acct_${'A'.repeat(24)}`;
  const credit = '987654.321';

  const fleet = {
    ...FLEET_V1_FIXTURE,
    agents: [
      { agent: 'codex-cmp', repo: 'ashlrai/phantom', task: `rotate ${ghToken} then ping`, claim_id: 'clm_secret_claim', expires_at: '2026-10-26T13:00:00Z', lease, capability, token: apiKey },
      { agent: ghToken, repo: 'ashlrai/phantom', task: 'id is a token', claim_id: null, expires_at: null },
    ],
    coordination: { state: 'known', claims: [{ id: 'clm_secret_claim', lease }], messages: [], proposals: [] },
  };
  const seats: VerseSeat[] = SEATS_FIXTURE.map((s) => s.id === 'codex-cmp'
    ? {
        ...s,
        label: `CMP Codex token=${apiKey}`,
        accountId: accountSecret,
        capacity: {
          accountHint: capability,
          planType: 'pro',
          binding: null,
          windows: [],
          credits: { hasCredits: true, unlimited: false, balance: credit },
          usability: 'ready',
          observedAt: null,
          evidenceSource: 'collector',
          notes: [],
        },
      }
    : s);
  const preferences = { 'codex-cmp': { name: `Bearer ${apiKey}`, team: ghToken, capability } };

  const roster = buildAgentRoster({ fleet, seats, preferences, now });
  const rendered = JSON.stringify(roster);

  it('never carries a token, lease, capability, account id, claim id or credit value', () => {
    for (const value of [ghToken, apiKey, lease, capability, accountSecret, credit, 'clm_secret_claim']) {
      expect(rendered).not.toContain(value);
    }
  });

  it('drops an agent whose id is credential-shaped and scrubs free text', () => {
    expect(roster.agents.map((a) => a.id)).toEqual(['codex-cmp']);
    const cmp = roster.agents[0]!;
    expect(cmp.claims[0]?.task).toContain('[REDACTED]');
    expect(cmp.name).toContain('[REDACTED]');
    expect(cmp.seat?.label).toContain('[REDACTED]');
  });

  it('projects only the roster fields', () => {
    expect(Object.keys(roster).sort()).toEqual(['agents', 'generatedAt', 'pools', 'schema', 'state']);
    expect(Object.keys(roster.agents[0]!).sort()).toEqual(['avatar', 'claims', 'hidden', 'id', 'labelColor', 'name', 'notify', 'pinned', 'pool', 'poolLabel', 'seat', 'team']);
    expect(Object.keys(roster.agents[0]!.claims[0]!).sort()).toEqual(['expiresAt', 'repo', 'task']);
    expect(Object.keys(roster.agents[0]!.seat!).sort()).toEqual(['disabled', 'engine', 'label', 'modelLabel', 'seatId']);
  });
});

describe('rosterSections', () => {
  const roster = buildAgentRoster({ fleet: FLEET_V1_FIXTURE, seats: SEATS_FIXTURE, preferences: PREFERENCES_FIXTURE, now });

  it('puts pinned agents first, then teams alphabetically, hiding hidden agents', () => {
    expect(rosterSections(roster.agents).map((s) => [s.title, s.agents.map((a) => a.id)])).toEqual([
      [PINNED_SECTION, ['codex-cmp']],
      ['Claude', ['claude', 'ag_k3m9x2p7q4']],
      ['Design', ['cursor']],
    ]);
  });

  it('shows hidden agents on request', () => {
    expect(rosterSections(roster.agents, { showHidden: true }).map((s) => s.title)).toEqual([PINNED_SECTION, 'Claude', 'Design', 'Local']);
  });

  it('puts Unassigned last and returns no empty sections', () => {
    const r = buildAgentRoster({
      fleet: { ...FLEET_V1_FIXTURE, agents: [{ agent: 'ag_aaaaaaaa', claim_id: null }, { agent: 'devin', claim_id: null }, { agent: 'cursor', claim_id: null }] },
      now,
    });
    expect(rosterSections(r.agents).map((s) => s.title)).toEqual(['Cursor', 'Devin', UNASSIGNED_TEAM]);
    expect(rosterSections([])).toEqual([]);
  });
});
