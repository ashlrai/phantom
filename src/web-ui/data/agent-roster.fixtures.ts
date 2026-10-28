/**
 * data/agent-roster.fixtures.ts - read-only fixtures for the agent roster
 * adapter: a fleet.v1 snapshot (the shape `phm fleet status --json` writes),
 * the matching Verse seats, and stored preferences. Every value is fictional.
 * The sidebar's own tests and previews render these until the live source is
 * wired; nothing here is fetched or written.
 */
import type { VerseSeat } from '../../core/verse/types.js';

export const ROSTER_FIXTURE_NOW = Date.parse('2026-10-26T12:00:00.000Z');

/** A fleet.v1 document with claimed, unclaimed, aliased and expired agents. */
export const FLEET_V1_FIXTURE = {
  schema: 'fleet.v1',
  generated_at: '2026-10-26T12:00:00.000Z',
  readings: [],
  windows: [],
  pools: [
    { id: 'grok-ultra-weekly', shared_with: null, source: 'estimate', used_pct: 36 },
    { id: 'codex-cmp', shared_with: null, source: 'unknown', used_pct: null },
    { id: 'codex-personal', shared_with: null, source: 'unknown', used_pct: null },
    { id: 'claude-max', shared_with: null, source: 'unknown', used_pct: null },
    { id: 'devin', shared_with: null, source: 'unknown', used_pct: null },
    { id: 'grok-build', shared_with: null, source: 'unknown', used_pct: null },
    { id: 'cursor', shared_with: 'grok-ultra-weekly', source: 'unknown', used_pct: null },
    { id: 'omlx', shared_with: null, source: 'unknown', used_pct: null },
  ],
  router: { source: 'unknown', decisions: null, regret: null },
  agents: [
    { agent: 'codex-cmp', repo: 'ashlrai/phantom', task: 'Review fleet evidence', claim_id: 'clm_a1', expires_at: '2026-10-26T13:00:00.000Z' },
    { agent: 'codex-cmp', repo: 'ashlrai/locus', task: 'Tighten seat probe', claim_id: 'clm_a2', expires_at: '2026-10-26T14:00:00.000Z' },
    // Expired an hour ago: the host board drops it, so does the roster.
    { agent: 'codex-personal', repo: 'ashlrai/lexicon', task: 'Stale claim', claim_id: 'clm_b1', expires_at: '2026-10-26T11:00:00.000Z' },
    { agent: 'cursor', repo: 'ashlrai/phantom', task: 'Sidebar layout pass', claim_id: 'clm_c1', expires_at: '2026-10-26T12:30:00.000Z' },
    { agent: 'claude', repo: 'unknown', task: 'unknown', claim_id: null, expires_at: null },
    { agent: 'local', repo: 'unknown', task: 'unknown', claim_id: null, expires_at: null },
    { agent: 'ag_k3m9x2p7q4', repo: 'unknown', task: 'unknown', claim_id: null, expires_at: null },
  ],
  repos: [{ repo: 'ashlrai/phantom', source: 'unknown', open: null, merged: null, complete: false }],
  coordination: { state: 'known', claims: [], messages: [], proposals: [], expiredClaims: null },
  sources: { shared: 'known', github: 'unknown', spend: 'unknown', router: 'unknown', planner: 'unknown' },
} as const;

/** fleet.v1 when coordination could not be read: agents unknown, not zero. */
export const FLEET_V1_UNKNOWN_AGENTS_FIXTURE = { ...FLEET_V1_FIXTURE, agents: null } as const;

function seat(id: string, engine: VerseSeat['engine'], label: string, models: Array<[string, string]>, unavailable?: string): VerseSeat {
  return {
    id,
    engine,
    label,
    accountId: id === 'local:qwen3-coder' ? 'local' : `acct-${id}`,
    models: models.map(([modelId, modelLabel]) => ({ id: modelId, label: modelLabel, contextWindow: null })),
    contextWindow: null,
    health: unavailable
      ? { state: 'unavailable', summary: unavailable, windows: [], observedAt: null }
      : { state: 'ready', summary: null, windows: [], observedAt: null },
  };
}

/** The seats `phm seats` would list for the same machine. */
export const SEATS_FIXTURE: VerseSeat[] = [
  seat('claude', 'claude', 'Claude Code', [['claude-opus-5-5', 'Opus 5.5']]),
  seat('codex-personal', 'codex', 'Personal Codex', [['gpt-5.5-codex', 'GPT-5.5 Codex']]),
  seat('codex-cmp', 'codex', 'CMP Codex', [['gpt-5.5-codex', 'GPT-5.5 Codex']]),
  seat('devin', 'devin', 'Devin', [['devin', 'Devin']], 'Devin is signed out.'),
  seat('local:qwen3-coder', 'local', 'Qwen3-Coder (local)', [['qwen3-coder', 'Qwen3-Coder']]),
];

/** Stored sidebar choices, including fields the parser must drop. */
export const PREFERENCES_FIXTURE = {
  'codex-cmp': { pinned: true, color: 'violet', shape: 'hexagon', labelColor: 'teal' },
  cursor: { team: 'Design', notify: false, name: 'Cursor (UI)' },
  local: { hidden: true },
  'ag_k3m9x2p7q4': { name: 'Docs sweeper', pool: 'claude-max' },
  // Ill-typed or unknown values are ignored one field at a time.
  claude: { color: 'url(javascript:alert(1))', shape: 'star', pinned: 'yes', pool: 'gpt-9', notify: false },
};
