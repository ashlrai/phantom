/**
 * Lane tool parity: which lane declares which tool, and which lanes can take a
 * job that needs a given set of tools. Backs `phm tools`, `phm tools parity|requires`
 * and the desktop Tools panel (GET /api/tools), so every surface reads one source.
 *
 * Declarations only, never a live probe. A capability no source declares is
 * `unknown`, and unknown is never shown or counted as missing: only an explicit
 * `false` makes a gap or refuses a lane, the same rule the router uses
 * (lane-capabilities.ts `laneLacks`).
 *
 * Sources, later ones win per field (MCP server names are unioned):
 *   1. router: DECLARED_LANE_CAPABILITIES (gh -> github-read, browser -> browser)
 *   2. connectors: ~/.phantom/connectors/profile.toml MCP, CLI and plugin connectors
 *      with an explicit lane list (an empty list is discovery, not a grant, so it is skipped)
 *   3. lane-tools.json: `<runs>/queue/lane-tools.json`, the host's own declarations
 * Lanes come from `<runs>/queue/slots.json` plus any lane a source names.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DECLARED_LANE_CAPABILITIES } from './lane-capabilities.js';

/** Fixed column order; JSON output follows it. github-write means through the bridge publish path, not gh in the worker. */
export const TOOL_CAPABILITIES = ['github-read', 'github-write', 'web-search', 'browser', 'computer-use', 'shell', 'package-install'] as const;
export type ToolCapability = typeof TOOL_CAPABILITIES[number];
export type ToolValue = 'yes' | 'no' | 'unknown';
/** Named tool kinds a lane lists by name: MCP servers, CLIs, skills and plugins. */
export const NAMED_TOOL_KINDS = ['mcp', 'cli', 'skill', 'plugin'] as const;
export type NamedToolKind = typeof NAMED_TOOL_KINDS[number];
/** A capability name, or `<kind>:<name>` for one named tool, e.g. `mcp:context7`, `skill:review`. */
export type ToolNeed = ToolCapability | `${NamedToolKind}:${string}`;

/** Per kind: the names the lane gets. Absent or null: not declared. */
export type LaneToolDeclaration = { capabilities?: Partial<Record<ToolCapability, boolean | null>> } & { [K in NamedToolKind]?: readonly string[] | null };
export interface ToolSource { name: 'router' | 'connectors' | 'lane-tools.json'; lanes: Readonly<Record<string, LaneToolDeclaration>> }
export type SourceState = 'healthy' | 'missing' | 'degraded';

export type ToolParityLane = { lane: string; capabilities: Record<ToolCapability, ToolValue> } & { [K in NamedToolKind]: string[] | null } & {
  /** Per need, the source a yes or no was read from. Unknown needs have no entry. */
  from: Record<string, string>;
};
export interface ToolParityReport {
  schema: 'tools.parity.v1';
  /** full: every lane declares every tool; gaps: some lane is declared to lack one; unknown: no gaps, but not everything is declared. */
  parity: 'full' | 'gaps' | 'unknown';
  capabilities: ToolCapability[];
  mcpServers: string[];
  /** Every row in fixed order: capabilities, then named tools by kind and name. */
  needs: ToolNeed[];
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
  /** Per lane and kind, the last source that declared a list; a list without an item says "no" for it. */
  const listedBy = new Map<string, Partial<Record<NamedToolKind, string>>>();
  const lanes = [...names].filter(lane => LANE_RE.test(lane)).sort(byName).map((lane): ToolParityLane => {
    const capabilities = Object.fromEntries(TOOL_CAPABILITIES.map(c => [c, 'unknown'])) as Record<ToolCapability, ToolValue>;
    const named = new Map<NamedToolKind, Set<string>>();
    const listed: Partial<Record<NamedToolKind, string>> = {};
    listedBy.set(lane, listed);
    const from: Record<string, string> = {};
    for (const source of input.sources) {
      const declared = source.lanes[lane];
      for (const c of TOOL_CAPABILITIES) {
        const value = declared?.capabilities?.[c];
        if (typeof value === 'boolean') { capabilities[c] = value ? 'yes' : 'no'; from[c] = source.name; }
      }
      for (const kind of NAMED_TOOL_KINDS) {
        const list = declared?.[kind];
        if (!Array.isArray(list)) continue;
        const set = named.get(kind) ?? new Set<string>();
        named.set(kind, set);
        listed[kind] = source.name;
        for (const item of list) if (MCP_RE.test(item)) { set.add(item); from[`${kind}:${item}`] = source.name; }
      }
    }
    const row = { lane, capabilities } as ToolParityLane;
    for (const kind of NAMED_TOOL_KINDS) { const set = named.get(kind); row[kind] = set ? [...set].sort(byName) : null; }
    row.from = from;
    return row;
  });
  const namedNeeds = NAMED_TOOL_KINDS.flatMap(kind => [...new Set(lanes.flatMap(l => l[kind] ?? []))].sort(byName).map(n => `${kind}:${n}` as ToolNeed));
  for (const lane of lanes) {
    const listed = listedBy.get(lane.lane)!;
    for (const need of namedNeeds) {
      const source = listed[namedKind(need)!];
      if (!(need in lane.from) && source) lane.from[need] = source;
    }
    lane.from = Object.fromEntries(Object.entries(lane.from).sort(([a], [b]) => byName(a, b)));
  }
  const needs: ToolNeed[] = [...TOOL_CAPABILITIES, ...namedNeeds];
  const collect = (want: ToolValue) => needs
    .map(need => ({ need, lanes: lanes.filter(l => laneHas(l, need) === want).map(l => l.lane) }))
    .filter(row => row.lanes.length > 0);
  const gaps = collect('no');
  const unknown = collect('unknown');
  return {
    schema: 'tools.parity.v1', parity: gaps.length ? 'gaps' : unknown.length || !lanes.length ? 'unknown' : 'full',
    capabilities: [...TOOL_CAPABILITIES], mcpServers: namedNeeds.filter(n => n.startsWith('mcp:')).map(n => n.slice(4)),
    needs, lanes, gaps, unknown, sources: input.states ?? input.sources.map(s => ({ name: s.name, state: 'declared' as const })),
  };
}

/** One lane's value for one need. A named tool is `no` only when the lane declares a list of that kind without it. */
export function laneHas(lane: ToolParityLane, need: ToolNeed): ToolValue {
  const kind = namedKind(need);
  if (kind) { const list = lane[kind]; return list == null ? 'unknown' : list.includes(need.slice(kind.length + 1)) ? 'yes' : 'no'; }
  return lane.capabilities[need as ToolCapability] ?? 'unknown';
}

function namedKind(need: string): NamedToolKind | null {
  const kind = need.slice(0, Math.max(0, need.indexOf(':')));
  return (NAMED_TOOL_KINDS as readonly string[]).includes(kind) ? kind as NamedToolKind : null;
}

/** Parse `github-read,browser,mcp:context7`. Returns null with the bad word when a need is not recognised. */
export function parseToolNeeds(text: string): { needs: ToolNeed[] } | { error: string } {
  const words = [...new Set(text.split(',').map(w => w.trim()).filter(Boolean))];
  if (!words.length) return { error: 'No needs given.' };
  for (const word of words) {
    const kind = namedKind(word);
    const ok = (TOOL_CAPABILITIES as readonly string[]).includes(word) || (kind !== null && MCP_RE.test(word.slice(kind.length + 1)));
    if (!ok) return { error: `Unknown need "${word.slice(0, 40)}". Use ${TOOL_CAPABILITIES.join(', ')} or mcp:|cli:|skill:|plugin:<name>.` };
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

const SHORT: Record<ToolCapability, string> = { 'github-read': 'gh-read', 'github-write': 'gh-write', 'web-search': 'search', browser: 'browser', 'computer-use': 'computer', shell: 'shell', 'package-install': 'install' };
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
 * `{ "v": 1, "lanes": { "<lane>": { "github-read": true, "browser": false, "mcp": ["context7"], "skill": ["review"] } } }`.
 * Fields other than booleans (or a string array for mcp, cli, skill, plugin) are ignored, not guessed.
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
    const decl: LaneToolDeclaration = { capabilities };
    for (const kind of NAMED_TOOL_KINDS) {
      const list = row[kind];
      decl[kind] = Array.isArray(list) && list.every(s => typeof s === 'string') ? list as string[] : null;
    }
    out[lane] = decl;
  }
  return out;
}

/** Each reader fails on its own. Tests inject fixtures here instead of touching disk. */
export interface ToolParityReaders {
  /** Connector profile entries: id, kind and the lanes they name. */
  connectors?: () => Promise<ReadonlyArray<{ id: string; kind: string; lanes: readonly string[] }>>;
  /** Raw lane-tools.json text, or null when the file is absent. */
  laneTools?: () => Promise<string | null>;
  /** Lane ids and the state of the slots file they came from. */
  slots?: () => Promise<{ lanes: string[]; sourceState: SourceState }>;
}
export interface ToolParityOptions { runsDir?: string; home?: string; readers?: ToolParityReaders }

const CONNECTOR_KIND: Readonly<Record<string, NamedToolKind>> = { 'mcp-stdio': 'mcp', 'mcp-http': 'mcp', cli: 'cli', plugin: 'plugin' };

/** Read every source; each fails on its own and is reported as missing or degraded. Never installs, enables or changes anything. */
export async function loadToolParity(opts: ToolParityOptions = {}): Promise<ToolParityReport> {
  const runs = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const readers: Required<ToolParityReaders> = {
    connectors: async () => (await (await import('../connectors/profile.js')).readProfile(opts.home)).connectors,
    laneTools: async () => {
      if (!isAbsolute(runs)) throw new Error('runs dir must be absolute');
      return readSmall(join(runs, 'queue', 'lane-tools.json'));
    },
    slots: async () => {
      const targets = await (await import('./runs-lane-targets.js')).readLaneTargets({ runsDir: runs });
      return { lanes: targets.lanes.map(l => l.lane), sourceState: targets.sourceState };
    },
    ...opts.readers,
  };
  const states: ToolParityReport['sources'] = [{ name: 'router', state: 'declared' }];
  const sources: ToolSource[] = [routerToolSource()];

  try {
    const connectors = await readers.connectors();
    const lanes: Record<string, LaneToolDeclaration> = {};
    for (const c of connectors) {
      const kind = CONNECTOR_KIND[c.kind];
      if (!kind) continue;
      for (const lane of c.lanes) { const decl = (lanes[lane] ??= {}); decl[kind] = [...(decl[kind] ?? []), c.id]; }
    }
    sources.push({ name: 'connectors', lanes });
    states.push({ name: 'connectors', state: connectors.length ? 'healthy' : 'missing' });
  } catch { states.push({ name: 'connectors', state: 'degraded' }); }

  try {
    const text = await readers.laneTools();
    const lanes = text === null ? null : parseLaneTools(JSON.parse(text));
    if (lanes) sources.push({ name: 'lane-tools.json', lanes });
    states.push({ name: 'lane-tools.json', state: text === null ? 'missing' : lanes ? 'healthy' : 'degraded' });
  } catch { states.push({ name: 'lane-tools.json', state: 'degraded' }); }

  let laneIds: string[] = [];
  try {
    const slots = await readers.slots();
    laneIds = slots.lanes;
    states.push({ name: 'slots.json', state: slots.sourceState });
  } catch { states.push({ name: 'slots.json', state: 'degraded' }); }

  return buildToolParity({ lanes: laneIds, sources, states });
}

export interface ToolCell { value: ToolValue; /** Where a yes or no was read from; null when no source declares it. */ source: string | null }
export interface ToolMatrixRow { need: ToolNeed; kind: 'capability' | NamedToolKind; label: string; cells: Record<string, ToolCell> }
export interface ToolLaneScore { lane: string; /** Whole percent of rows that are yes. */ score: number; yes: number; no: number; unknown: number }
export interface ToolGap { need: ToolNeed; label: string; state: 'missing' | 'unknown'; lanes: string[]; fix: string }
/** The `phm tools` view and the desktop Tools panel: rows by lane, a score per lane and the top gaps. */
export interface ToolMatrix {
  schema: 'tools.matrix.v1';
  parity: ToolParityReport['parity'];
  lanes: string[];
  rows: ToolMatrixRow[];
  scores: ToolLaneScore[];
  /** At most three: declared-missing first, then the most-unknown; most lanes first, then row order. */
  topGaps: ToolGap[];
  sources: ToolParityReport['sources'];
}

const LABEL: Record<ToolCapability, string> = {
  'github-read': 'GitHub read', 'github-write': 'GitHub write', 'web-search': 'Web search', browser: 'Browser',
  'computer-use': 'Computer use', shell: 'Shell', 'package-install': 'Package install',
};
const KIND_LABEL: Record<NamedToolKind, string> = { mcp: 'MCP server', cli: 'CLI', skill: 'Skill', plugin: 'Plugin' };
export function toolLabel(need: ToolNeed): string {
  const kind = namedKind(need);
  return kind ? `${KIND_LABEL[kind]} ${need.slice(kind.length + 1)}` : LABEL[need as ToolCapability] ?? need;
}

/** One plain sentence; advice only, never applied. */
function gapFix(need: ToolNeed, state: ToolGap['state'], lanes: readonly string[]): string {
  const who = lanes.length === 1 ? lanes[0]! : `${lanes.length} lanes`;
  const kind = namedKind(need);
  const record = kind ? `list "${need.slice(kind.length + 1)}" under "${kind}"` : `set "${need}": true`;
  return state === 'missing'
    ? `Add ${toolLabel(need)} to the launch config of ${who}, then ${record} in <runs>/queue/lane-tools.json.`
    : `Check ${toolLabel(need)} on ${who} and record yes or no in <runs>/queue/lane-tools.json.`;
}

/** Pure projection of a parity report. `lane` narrows every part to that lane; an unknown lane yields null. */
export function buildToolMatrix(report: ToolParityReport, lane?: string): ToolMatrix | null {
  const picked = lane === undefined ? report.lanes : report.lanes.filter(l => l.lane === lane);
  if (lane !== undefined && !picked.length) return null;
  const rows = report.needs.map((need): ToolMatrixRow => ({
    need, kind: namedKind(need) ?? 'capability', label: toolLabel(need),
    cells: Object.fromEntries(picked.map(l => [l.lane, { value: laneHas(l, need), source: l.from[need] ?? null }])),
  }));
  const scores = picked.map((l): ToolLaneScore => {
    const values = report.needs.map(n => laneHas(l, n));
    const yes = values.filter(v => v === 'yes').length;
    return { lane: l.lane, score: values.length ? Math.round((100 * yes) / values.length) : 0, yes, no: values.filter(v => v === 'no').length, unknown: values.filter(v => v === 'unknown').length };
  });
  const ranked = (state: ToolGap['state'], value: ToolValue) => rows
    .map(row => ({ row, lanes: picked.filter(l => row.cells[l.lane]!.value === value).map(l => l.lane) }))
    .filter(x => x.lanes.length)
    .sort((a, b) => b.lanes.length - a.lanes.length)
    .map(({ row, lanes }): ToolGap => ({ need: row.need, label: row.label, state, lanes, fix: gapFix(row.need, state, lanes) }));
  return {
    schema: 'tools.matrix.v1', parity: report.parity, lanes: picked.map(l => l.lane), rows, scores,
    topGaps: [...ranked('missing', 'no'), ...ranked('unknown', 'unknown')].slice(0, 3), sources: report.sources,
  };
}

/** Human view: one line per lane score, then the top gaps. `--lane` shows that lane's list instead. */
export function formatToolMatrix(m: ToolMatrix, lane?: string): string {
  const mark = (v: ToolValue): string => (v === 'unknown' ? '?' : v);
  const lines: string[] = [];
  if (lane) {
    const s = m.scores[0]!;
    lines.push(`${lane}: ${s.score}% of ${m.rows.length} tools (${s.yes} yes, ${s.no} no, ${s.unknown} unknown).`);
    for (const row of m.rows) { const c = row.cells[lane]!; lines.push(`  ${mark(c.value).padEnd(4)}${row.label}${c.source ? `  (${c.source})` : ''}`); }
  } else {
    lines.push(`Tools: ${m.lanes.length} lane(s), ${m.rows.length} tool(s), parity ${m.parity}.`);
    if (!m.lanes.length) lines.push('No lanes found.');
    const width = Math.max(4, ...m.lanes.map(l => l.length)) + 2;
    for (const s of m.scores) lines.push(`  ${s.lane.padEnd(width)}${`${s.score}%`.padStart(4)}  ${s.yes} yes, ${s.no} no, ${s.unknown} unknown`);
  }
  lines.push(m.topGaps.length ? 'Top gaps:' : 'Top gaps: none.');
  m.topGaps.forEach((g, i) => lines.push(`  ${i + 1}. ${g.label} ${g.state} on ${g.lanes.join(', ')}. ${g.fix}`));
  const unread = m.sources.filter(s => s.state === 'degraded').map(s => s.name);
  if (unread.length) lines.push(`Could not read: ${unread.join(', ')}.`);
  lines.push(lane ? '? = not declared. Full matrix: phm tools --json' : 'One lane: phm tools --lane <lane>. Full matrix: phm tools --json');
  return lines.join('\n');
}
