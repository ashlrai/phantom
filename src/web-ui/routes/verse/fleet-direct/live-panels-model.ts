/**
 * routes/verse/fleet-direct/live-panels-model.ts: the six read-only live panels
 * (fleet, merges, releases, nodes, agents, spend). Pure: the feeds other panes
 * already read in, one compact view per panel out. No new backend and nothing
 * invented: a reading a feed does not carry is left out, a feed that is down
 * becomes an `error` panel, and a feed that is up but has nothing in it becomes
 * an `empty` panel with its own words.
 */
import type { NodesSnapshot } from '../../../../core/nodes/view.js';
import type { OpsReleasesV1 } from '../../../../core/verse/ops-types.js';
import { claimsByOwner } from '../fleet-org/org-roster.js';

export type PanelId = 'fleet' | 'merges' | 'releases' | 'nodes' | 'agents' | 'spend';
export type PanelState = 'live' | 'empty' | 'error';
export interface PanelRow { label: string; value: string }
export interface LivePanel { id: PanelId; title: string; state: PanelState; headline: string; rows: PanelRow[] }

export interface LivePanelsInput {
  /** GET /api/verse/fleet/runs, unnarrowed. */
  runs: unknown;
  /** GET /api/verse/ops/releases; null when the feed is down or absent. */
  releases: OpsReleasesV1 | null;
  /** GET /api/nodes; null when the feed is down. */
  nodes: NodesSnapshot | null;
  /** GET /api/verse/fleet/agent-roster, unnarrowed. */
  roster: unknown;
}

const MAX_ROWS = 4;
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const panel = (id: PanelId, title: string, state: PanelState, headline: string, rows: PanelRow[] = []): LivePanel =>
  ({ id, title, state, headline, rows: rows.slice(0, MAX_ROWS) });
const down = (id: PanelId, title: string, what: string) => panel(id, title, 'error', `${what} not reported right now`);

function fleetPanel(runs: unknown): LivePanel {
  const lanes = record(runs).lanes;
  if (!Array.isArray(lanes)) return down('fleet', 'Fleet', 'Fleet lanes');
  const rows = lanes.map(record).filter(l => typeof l.lane === 'string');
  if (rows.length === 0) return panel('fleet', 'Fleet', 'empty', 'No lanes reported');
  const running = rows.reduce((n, l) => n + (num(l.running) ?? 0), 0);
  const target = rows.reduce((n, l) => n + (num(l.target) ?? 0), 0);
  const held = rows.filter(l => l.held === true);
  return panel('fleet', 'Fleet', 'live', `${running} of ${target} slots running`, [
    { label: 'Lanes', value: String(rows.length) },
    { label: 'Held', value: held.length ? held.map(l => String(l.lane)).join(', ') : 'none' },
    { label: 'Queued', value: String(rows.reduce((n, l) => n + (num(l.queued) ?? 0), 0)) },
  ]);
}

function mergesPanel(runs: unknown): LivePanel {
  const merges = record(record(runs).mergesLastHour);
  const count = num(merges.count);
  if (count === null) return down('merges', 'Merges', 'Merges');
  if (count === 0) return panel('merges', 'Merges', 'empty', 'No merges in the last hour');
  const items = Array.isArray(merges.items) ? merges.items.map(record) : [];
  return panel('merges', 'Merges', 'live', `${plural(count, 'merge')} in the last hour`,
    items.filter(i => typeof i.repo === 'string' && num(i.number) !== null).map(i => ({ label: `${String(i.repo).split('/').pop()}#${i.number}`, value: String(i.title ?? '') })));
}

function releasesPanel(releases: OpsReleasesV1 | null): LivePanel {
  if (!releases) return down('releases', 'Releases', 'Releases');
  if (releases.repos.length === 0) return panel('releases', 'Releases', 'empty', 'No repos reported');
  const ahead = releases.repos.filter(r => (r.commitsSinceTag ?? 0) > 0).length;
  return panel('releases', 'Releases', 'live', `${plural(releases.repos.length, 'repo')} · ${ahead} with unreleased commits`,
    releases.repos.map(r => ({ label: r.repo, value: [r.latestTag ?? r.version ?? 'no tag', r.commitsSinceTag ? `+${r.commitsSinceTag}` : null].filter(Boolean).join(' ') })));
}

function nodesPanel(nodes: NodesSnapshot | null): LivePanel {
  if (!nodes || !Array.isArray(nodes.nodes)) return down('nodes', 'Nodes', 'Nodes');
  if (nodes.nodes.length === 0) {
    return nodes.error ? panel('nodes', 'Nodes', 'error', `Node inventory: ${nodes.error}`) : panel('nodes', 'Nodes', 'empty', 'No nodes have joined');
  }
  const ready = nodes.nodes.filter(n => n.status === 'ready').length;
  return panel('nodes', 'Nodes', 'live', `${ready} of ${nodes.nodes.length} ready`,
    nodes.nodes.map(n => ({ label: n.id, value: n.leader ? `${n.status} · leader` : n.status })));
}

function agentsPanel(roster: unknown): LivePanel {
  const claims = claimsByOwner(roster);
  if (!claims) return down('agents', 'Agents', 'Agent claims');
  if (claims.size === 0) return panel('agents', 'Agents', 'empty', 'No active claims');
  const total = [...claims.values()].reduce((a, b) => a + b, 0);
  return panel('agents', 'Agents', 'live', `${plural(total, 'active claim')} across ${plural(claims.size, 'agent')}`,
    [...claims].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([owner, n]) => ({ label: owner, value: String(n) })));
}

/** Included usage only: the personal plan percentage and tokens per lane, exactly as reported. */
function spendPanel(runs: unknown): LivePanel {
  const data = record(runs);
  if (!Array.isArray(data.lanes) && data.codexPersonal === undefined) return down('spend', 'Spend', 'Spend');
  const pct = num(record(data.codexPersonal).usedPct);
  const tokens = (Array.isArray(data.lanes) ? data.lanes.map(record) : [])
    .flatMap(l => typeof l.lane === 'string' && num(l.tokensLastHour) !== null ? [{ lane: l.lane, tokens: l.tokensLastHour as number }] : [])
    .filter(t => t.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  if (pct === null && tokens.length === 0) return panel('spend', 'Spend', 'empty', 'No usage reported');
  const total = tokens.reduce((n, t) => n + t.tokens, 0);
  return panel('spend', 'Spend', 'live', pct === null ? `${total.toLocaleString('en-US')} tokens in the last hour` : `${Math.round(pct)}% of the personal plan used`,
    [...(pct !== null && tokens.length ? [{ label: 'Last hour', value: `${total.toLocaleString('en-US')} tokens` }] : []),
      ...tokens.map(t => ({ label: t.lane, value: `${t.tokens.toLocaleString('en-US')} tokens` }))]);
}

export function buildLivePanels(input: LivePanelsInput): LivePanel[] {
  return [fleetPanel(input.runs), mergesPanel(input.runs), releasesPanel(input.releases), nodesPanel(input.nodes), agentsPanel(input.roster), spendPanel(input.runs)];
}
