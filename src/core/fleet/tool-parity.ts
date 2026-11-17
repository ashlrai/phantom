/**
 * Lane tool parity: which lane declares which tool, and which lanes can take a
 * job that needs a given set of tools. Backs `phm tools parity|requires`.
 *
 * Declarations only, never a live probe. A capability no source declares is
 * `unknown`, and unknown is never shown or counted as missing: only an explicit
 * `false` makes a gap or refuses a lane, the same rule the router uses
 * (lane-capabilities.ts `laneLacks`).
 *
 * Sources, later ones win per field (MCP server names are unioned):
 *   1. router: DECLARED_LANE_CAPABILITIES (gh -> github-read, browser -> browser)
 *   2. connectors: ~/.phantom/connectors/profile.toml MCP connectors with an
 *      explicit lane list (an empty list is discovery, not a grant, so it is skipped)
 *   3. lane-tools.json: `<runs>/queue/lane-tools.json`, the host's own declarations
 * Lanes come from `<runs>/queue/slots.json` plus any lane a source names.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DECLARED_LANE_CAPABILITIES } from './lane-capabilities.js';

/** Fixed column order; JSON output follows it. github-write means through the bridge publish path, not gh in the worker. */
export const TOOL_CAPABILITIES = ['github-read', 'github-write', 'web-search', 'browser', 'shell', 'package-install'] as const;
export type ToolCapability = typeof TOOL_CAPABILITIES[number];
export type ToolValue = 'yes' | 'no' | 'unknown';
/** A capability name, or `mcp:<server>` for one MCP server. */
export type ToolNeed = ToolCapability | `mcp:${string}`;

export interface LaneToolDeclaration {
  capabilities?: Partial<Record<ToolCapability, boolean | null>>;
  /** MCP server names the lane gets. Absent or null: not declared. */
  mcp?: readonly string[] | null;
}
export interface ToolSource { name: 'router' | 'connectors' | 'lane-tools.json'; lanes: Readonly<Record<string, LaneToolDeclaration>> }
export type SourceState = 'healthy' | 'missing' | 'degraded';

export interface ToolParityLane { lane: string; capabilities: Record<ToolCapability, ToolValue>; mcp: string[] | null }
export interface ToolParityReport {
  schema: 'tools.parity.v1';
  /** full: every lane declares every tool; gaps: some lane is declared to lack one; unknown: no gaps, but not everything is declared. */
  parity: 'full' | 'gaps' | 'unknown';
  capabilities: ToolCapability[];
  mcpServers: string[];
  lanes: ToolParityLane[];
  gaps: Array<{ need: ToolNeed; lanes: string[] }>;
  unknown: Array<{ need: ToolNeed; lanes: string[] }>;
  sources: Array<{ name: string; state: SourceState | 'declared' }>;
}

const LANE_RE = /^[a-z][a-z0-9-]{1,30}$/;
const MCP_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/;
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The router's declared capabilities in parity vocabulary. */
export function routerToolSource(): ToolSource {
  const lanes: Record<string, LaneToolDeclaration> = {};
  for (const [lane, caps] of Object.entries(DECLARED_LANE_CAPABILITIES)) {
    lanes[lane] = { capabilities: { 'github-read': caps.gh ?? null, browser: caps.browser ?? null } };
  }
  return { name: 'router', lanes };
}

/** Pure: merge sources into a lane-by-capability matrix with stable order. */
export function buildToolParity(input: { lanes?: readonly string[]; sources: readonly ToolSource[]; states?: ToolParityReport['sources'] }): ToolParityReport {
  const names = new Set(input.lanes ?? []);
  for (const source of input.sources) for (const lane of Object.keys(source.lanes)) names.add(lane);
  const lanes = [...names].filter(lane => LANE_RE.test(lane)).sort(byName).map((lane): ToolParityLane => {
    const capabilities = Object.fromEntries(TOOL_CAPABILITIES.map(c => [c, 'unknown'])) as Record<ToolCapability, ToolValue>;
    let mcp: Set<string> | null = null;
    for (const source of input.sources) {
      const declared = source.lanes[lane];
      for (const c of TOOL_CAPABILITIES) {
        const value = declared?.capabilities?.[c];
        if (typeof value === 'boolean') capabilities[c] = value ? 'yes' : 'no';
      }
      if (Array.isArray(declared?.mcp)) for (const server of declared.mcp) if (MCP_RE.test(server)) (mcp ??= new Set()).add(server);
    }
    return { lane, capabilities, mcp: mcp ? [...mcp].sort(byName) : null };
  });
  const mcpServers = [...new Set(lanes.flatMap(l => l.mcp ?? []))].sort(byName);
  const needs: ToolNeed[] = [...TOOL_CAPABILITIES, ...mcpServers.map(s => `mcp:${s}` as const)];
  const collect = (want: ToolValue) => needs
    .map(need => ({ need, lanes: lanes.filter(l => laneHas(l, need) === want).map(l => l.lane) }))
    .filter(row => row.lanes.length > 0);
  const gaps = collect('no');
  const unknown = collect('unknown');
  return {
    schema: 'tools.parity.v1', parity: gaps.length ? 'gaps' : unknown.length || !lanes.length ? 'unknown' : 'full',
    capabilities: [...TOOL_CAPABILITIES], mcpServers, lanes, gaps, unknown, sources: input.states ?? input.sources.map(s => ({ name: s.name, state: 'declared' as const })),
  };
}

/** One lane's value for one need. An MCP server is `no` only when the lane declares a server list without it. */
export function laneHas(lane: ToolParityLane, need: ToolNeed): ToolValue {
  if (need.startsWith('mcp:')) return lane.mcp === null ? 'unknown' : lane.mcp.includes(need.slice(4)) ? 'yes' : 'no';
  return lane.capabilities[need as ToolCapability] ?? 'unknown';
}

/** Parse `github-read,browser,mcp:context7`. Returns null with the bad word when a need is not recognised. */
export function parseToolNeeds(text: string): { needs: ToolNeed[] } | { error: string } {
  const words = [...new Set(text.split(',').map(w => w.trim()).filter(Boolean))];
  if (!words.length) return { error: 'No needs given.' };
  for (const word of words) {
    const ok = (TOOL_CAPABILITIES as readonly string[]).includes(word) || (word.startsWith('mcp:') && MCP_RE.test(word.slice(4)));
    if (!ok) return { error: `Unknown need "${word.slice(0, 40)}". Use ${TOOL_CAPABILITIES.join(', ')} or mcp:<server>.` };
  }
  return { needs: words as ToolNeed[] };
}

export interface ToolRequiresReport {
  schema: 'tools.requires.v1';
  needs: ToolNeed[];
  /** Lanes that declare every need. */
  can: string[];
  /** Lanes declared to lack none of the needs but not declaring all of them. The router does not refuse these. */
  unproven: Array<{ lane: string; unknown: ToolNeed[] }>;
  /** Lanes declared to lack at least one need. The router should not send the job here. */
  cannot: Array<{ lane: string; lacks: ToolNeed[] }>;
}

/** Which lanes can run a job with these needs. */
export function toolRequires(report: ToolParityReport, needs: readonly ToolNeed[]): ToolRequiresReport {
  const out: ToolRequiresReport = { schema: 'tools.requires.v1', needs: [...needs], can: [], unproven: [], cannot: [] };
  for (const lane of report.lanes) {
    const lacks = needs.filter(n => laneHas(lane, n) === 'no');
    const unknown = needs.filter(n => laneHas(lane, n) === 'unknown');
    if (lacks.length) out.cannot.push({ lane: lane.lane, lacks });
    else if (unknown.length) out.unproven.push({ lane: lane.lane, unknown });
    else out.can.push(lane.lane);
  }
  return out;
}

const SHORT: Record<ToolCapability, string> = { 'github-read': 'gh-read', 'github-write': 'gh-write', 'web-search': 'search', browser: 'browser', shell: 'shell', 'package-install': 'install' };
const cell = (v: ToolValue): string => (v === 'unknown' ? '?' : v);
const MAX_ROWS = 14;

/** At most 20 lines: summary, header, up to 14 lanes, overflow, gaps, unreadable sources, legend. */
export function formatToolParity(report: ToolParityReport): string {
  const width = Math.max(4, ...report.lanes.map(l => l.lane.length)) + 2;
  const cols = report.capabilities.map(c => SHORT[c]);
  const summary = report.parity === 'full' ? 'every lane declares every tool'
    : report.parity === 'gaps' ? `${report.gaps.length} tool(s) missing on some lane` : 'no gaps declared, but some tools are unknown';
  const lines = [`Tool parity: ${report.parity} (${summary}).`, ['lane'.padEnd(width), ...cols.map(c => c.padEnd(c.length + 1)), 'mcp'].join('')];
  for (const lane of report.lanes.slice(0, MAX_ROWS)) {
    const mcp = lane.mcp === null ? '?' : lane.mcp.length ? lane.mcp.join(',') : 'none';
    lines.push([lane.lane.padEnd(width), ...report.capabilities.map((c, i) => cell(lane.capabilities[c]).padEnd(cols[i]!.length + 1)), mcp.length > 40 ? `${mcp.slice(0, 39)}…` : mcp].join('').trimEnd());
  }
  if (report.lanes.length > MAX_ROWS) lines.push(`… ${report.lanes.length - MAX_ROWS} more lane(s); use JSON for all.`);
  if (!report.lanes.length) lines.push('No lanes found.');
  const gaps = report.gaps.map(g => `${g.need} (${g.lanes.join(', ')})`).join('; ');
  lines.push(gaps ? `Missing: ${gaps.length > 160 ? `${gaps.slice(0, 159)}…` : gaps}` : 'Missing: none declared.');
  const unread = report.sources.filter(s => s.state === 'degraded').map(s => s.name);
  if (unread.length) lines.push(`Could not read: ${unread.join(', ')}; their lanes and tools are not shown.`);
  lines.push('? = not declared, never counted as missing. Declare in <runs>/queue/lane-tools.json.');
  return lines.join('\n');
}

export function formatToolRequires(r: ToolRequiresReport): string {
  const list = (xs: string[]): string => (xs.length ? xs.join(', ') : 'none');
  return [
    `Needs: ${r.needs.join(', ')}`,
    `Can run: ${list(r.can)}`,
    `Not declared either way: ${list(r.unproven.map(u => `${u.lane} (${u.unknown.join(', ')})`))}`,
    `Cannot run: ${list(r.cannot.map(c => `${c.lane} (lacks ${c.lacks.join(', ')})`))}`,
  ].join('\n');
}

const MAX_BYTES = 256 * 1024;

/** Bounded, no-follow read. null when the file is absent; throws when it is unreadable or unsafe. */
async function readSmall(path: string): Promise<string | null> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('lane-tools.json is not a small regular file');
    return (await handle.readFile('utf8')).slice(0, MAX_BYTES);
  } finally { await handle.close(); }
}

/**
 * `{ "v": 1, "lanes": { "<lane>": { "github-read": true, "browser": false, "mcp": ["context7"] } } }`.
 * Fields other than booleans (or a string array for mcp) are ignored, not guessed.
 */
export function parseLaneTools(raw: unknown): ToolSource['lanes'] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { v, lanes } = raw as { v?: unknown; lanes?: unknown };
  if (v !== 1 || !lanes || typeof lanes !== 'object' || Array.isArray(lanes)) return null;
  const out: Record<string, LaneToolDeclaration> = {};
  for (const [lane, value] of Object.entries(lanes as Record<string, unknown>)) {
    if (!LANE_RE.test(lane) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const capabilities: Partial<Record<ToolCapability, boolean>> = {};
    for (const c of TOOL_CAPABILITIES) if (typeof row[c] === 'boolean') capabilities[c] = row[c] as boolean;
    const mcp = Array.isArray(row.mcp) && row.mcp.every(s => typeof s === 'string') ? row.mcp as string[] : null;
    out[lane] = { capabilities, mcp };
  }
  return out;
}

export interface ToolParityOptions { runsDir?: string; home?: string }

/** Read every source; each fails on its own and is reported as missing or degraded. */
export async function loadToolParity(opts: ToolParityOptions = {}): Promise<ToolParityReport> {
  const runs = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const states: ToolParityReport['sources'] = [{ name: 'router', state: 'declared' }];
  const sources: ToolSource[] = [routerToolSource()];

  try {
    const { readProfile } = await import('../connectors/profile.js');
    const profile = await readProfile(opts.home);
    const lanes: Record<string, LaneToolDeclaration> = {};
    for (const c of profile.connectors) {
      if (c.kind !== 'mcp-stdio' && c.kind !== 'mcp-http') continue;
      for (const lane of c.lanes) lanes[lane] = { mcp: [...(lanes[lane]?.mcp ?? []), c.id] };
    }
    sources.push({ name: 'connectors', lanes });
    states.push({ name: 'connectors', state: profile.connectors.length ? 'healthy' : 'missing' });
  } catch { states.push({ name: 'connectors', state: 'degraded' }); }

  try {
    if (!isAbsolute(runs)) throw new Error('runs dir must be absolute');
    const text = await readSmall(join(runs, 'queue', 'lane-tools.json'));
    const lanes = text === null ? null : parseLaneTools(JSON.parse(text));
    if (lanes) sources.push({ name: 'lane-tools.json', lanes });
    states.push({ name: 'lane-tools.json', state: text === null ? 'missing' : lanes ? 'healthy' : 'degraded' });
  } catch { states.push({ name: 'lane-tools.json', state: 'degraded' }); }

  let laneIds: string[] = [];
  try {
    const { readLaneTargets } = await import('./runs-lane-targets.js');
    const targets = await readLaneTargets({ runsDir: runs });
    laneIds = targets.lanes.map(l => l.lane);
    states.push({ name: 'slots.json', state: targets.sourceState });
  } catch { states.push({ name: 'slots.json', state: 'degraded' }); }

  return buildToolParity({ lanes: laneIds, sources, states });
}
