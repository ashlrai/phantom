/**
 * inventory.ts: everything this install can use, in one list. Messaging
 * channels, connectors, plugins, skills and tools, each with a plain state
 * (ready, needs setup, off, error, unknown), for `phm inventory`,
 * GET /api/verse/fleet/runs/inventory and the desktop Inventory pane.
 *
 * No second registry: channels come from channels-overview, connectors from
 * the connector profile, plugins and skills from installed-panels, tools from
 * tool-parity and the shared tool registry. This module only joins them.
 *
 * `buildInventory` is pure: every fact enters through `InventorySources`, and
 * a source that is null (could not be read) yields one 'unknown' row for it,
 * never a guess. Read-only. No credential value enters this module: connectors
 * carry only how many credential names they list.
 */
import type { RegistryTool } from '../connectors/registry.js';
import type { ChannelOverviewState, ChannelsOverview } from './channels-schema.js';
import { INVALID_MANIFEST_AGENTS, LEARNED_SKILLS_SOURCE, type InstalledPanel } from './installed-panels.js';
import {
  INVENTORY_KINDS, INVENTORY_KIND_LABELS, INVENTORY_SCHEMA, INVENTORY_STATES, INVENTORY_VERSION,
  type Inventory, type InventoryCounts, type InventoryItem, type InventoryKind, type InventoryNextStep, type InventoryState,
} from './inventory-schema.js';
import { ORG_LANES } from './org-map.js';
import { TOOL_CAPABILITIES, laneHas, toolLabel, type ToolNeed, type ToolParityReport } from './tool-parity.js';

export * from './inventory-schema.js';

/** One connector profile entry, already reduced to what may be shown. */
export interface ConnectorFact {
  id: string;
  kind: string;
  description: string | null;
  /** Lanes the profile lists; only a listed lane may run it. */
  lanes: readonly string[];
  /** How many credential names it lists. Names and values stay out. */
  credentials: number;
  /** Whether its program is on PATH; 'unknown' when there is none to check (a remote endpoint). */
  availability: 'available' | 'unavailable' | 'unknown';
}
export type RegistryFact = Pick<RegistryTool, 'id' | 'kind' | 'description' | 'lanes' | 'status'>;

/** Everything the inventory needs, read once. null: that source could not be read. */
export interface InventorySources {
  now: Date;
  channels: ChannelsOverview | null;
  connectors: readonly ConnectorFact[] | null;
  plugins: InstalledPanel | null;
  skills: InstalledPanel | null;
  /** Which lane has which tool (`phm tools`). */
  tools: ToolParityReport | null;
  /** The shared tool registry (`phm connectors tool list`). */
  registry: readonly RegistryFact[] | null;
  /** Lanes listed first in the parity; defaults to the org's lanes. */
  roster?: readonly string[];
}

type Verdict = 'has' | 'lacks' | 'unknown';
/** `verdict` is set on tools and connectors that count toward lane parity. */
interface Entry { item: InventoryItem; verdict?: (lane: string) => Verdict }

const LANE_TOOLS_FILE = '<runs>/queue/lane-tools.json';
const CHANNEL_STATE: Record<ChannelOverviewState, InventoryState> = { connected: 'ready', 'not-set-up': 'needs setup', failing: 'error', unknown: 'unknown' };
const CONNECTOR_KIND: Readonly<Record<string, string>> = { 'mcp-stdio': 'MCP server on this machine', 'mcp-http': 'Remote MCP server', cli: 'CLI', plugin: 'Plugin' };

const clip = (text: string, max = 200): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const zeroCounts = (): InventoryCounts => ({ ready: 0, 'needs setup': 0, off: 0, error: 0, unknown: 0 });
function countStates(items: readonly InventoryItem[]): InventoryCounts {
  const counts = zeroCounts();
  for (const item of items) counts[item.state]++;
  return counts;
}

/** The row an unreadable source leaves behind, so its absence is visible and counted as unknown. */
function unread(kind: InventoryKind, id: string, name: string): Entry {
  return { item: { kind, id: `${kind}:${id}`, name, state: 'unknown', detail: 'Could not read this source.', lastChecked: null, usedByLanes: 'unknown', next: null } };
}

/** A next step from a source sentence. The command to copy is the part in backticks, or a sentence that is itself a `phm` command. */
function nextFrom(text: string | null, fallback: InventoryNextStep | null): InventoryNextStep | null {
  if (!text) return fallback;
  return { text, command: /`([^`]{1,200})`/.exec(text)?.[1] ?? /^(phm [^—]{1,200}?)(?: —|$)/.exec(text)?.[1] ?? null };
}

function channelEntries(overview: ChannelsOverview | null): Entry[] {
  if (!overview) return [unread('channel', 'channels', 'Messaging channels')];
  return overview.channels.map((row): Entry => {
    const state = CHANNEL_STATE[row.state] ?? 'unknown';
    const traffic = row.messages24h === 'unknown' ? 'Message count unknown.' : `${plural(row.messages24h, 'message')} in the last 24 hours.`;
    const detail = row.reason ?? (state === 'ready' ? `Connected. ${traffic}` : state === 'needs setup' ? 'Not set up yet.' : 'State unknown.');
    const fallback = state === 'needs setup' ? { text: 'Set this channel up.', command: 'phm channels' } : null;
    // Channels carry messages between the owner and the Leader; no worker lane uses one.
    return { item: { kind: 'channel', id: `channel:${row.channel}`, name: row.label, state, detail: clip(detail), lastChecked: overview.at, usedByLanes: [], next: state === 'ready' ? null : nextFrom(row.next, fallback) } };
  });
}

function connectorEntries(connectors: readonly ConnectorFact[] | null, at: string): Entry[] {
  if (!connectors) return [unread('connector', 'profile', 'Connector profile')];
  return connectors.map((c): Entry => {
    const state: InventoryState = c.availability === 'available' ? 'ready' : c.availability === 'unavailable' ? 'needs setup' : 'unknown';
    const parts = [
      CONNECTOR_KIND[c.kind] ?? c.kind,
      ...(c.description ? [c.description.replace(/\.+$/, '')] : []),
      ...(state === 'needs setup' ? ['Its program is not on PATH'] : state === 'unknown' ? ['Not checked: nothing here contacts it'] : []),
      ...(c.credentials ? [`Lists ${plural(c.credentials, 'credential name')}; whether each is set is not checked here`] : []),
      ...(c.lanes.length ? [] : ['No lane is listed, so no lane can run it']),
    ];
    const next = state === 'needs setup' ? { text: 'Install its program so it is on PATH, then check it again.', command: `phm connectors show ${c.id}` } : null;
    const lanes = [...c.lanes];
    return {
      item: { kind: 'connector', id: `connector:${c.id}`, name: c.id, state, detail: clip(`${parts.join('. ')}.`), lastChecked: at, usedByLanes: lanes, next },
      verdict: lane => (lanes.includes(lane) ? 'has' : 'lacks'),
    };
  });
}

/** Plugins or skills from an installed panel, plus names a lane declares that no installed list holds. */
function installedEntries(kind: 'plugin' | 'skill', panel: InstalledPanel | null, tools: ToolParityReport | null, at: string): Entry[] {
  const label = INVENTORY_KIND_LABELS[kind].toLowerCase();
  const declaredFor = (name: string): string[] => (tools?.lanes ?? []).filter(l => l[kind]?.includes(name)).map(l => l.lane);
  const entries: Entry[] = [];
  if (!panel) entries.push(unread(kind, 'installed', `Installed ${label}`));
  for (const source of panel?.sources ?? []) if (source.state === 'unknown') entries.push(unread(kind, `${source.source}/?`, `${source.source} ${label}`));
  const seen = new Set<string>();
  for (const row of panel?.items ?? []) {
    seen.add(row.name);
    const invalid = row.agents === INVALID_MANIFEST_AGENTS;
    const state: InventoryState = invalid ? 'error' : row.enabled === 'unknown' ? 'unknown' : row.enabled ? 'ready' : 'off';
    const lanes = declaredFor(row.name);
    entries.push({ item: {
      kind, id: `${kind}:${row.source}/${row.name}`, name: row.name, state,
      detail: invalid ? `${row.source}. Its manifest is not valid, so nothing loads it.` : `${row.source}. ${row.agents}.`,
      lastChecked: panel!.observedAt,
      usedByLanes: lanes.length ? lanes : row.source === LEARNED_SKILLS_SOURCE ? [] : 'unknown',
      next: null,
    } });
  }
  for (const need of tools?.needs ?? []) {
    const name = need.startsWith(`${kind}:`) ? need.slice(kind.length + 1) : null;
    if (name === null || seen.has(name)) continue;
    entries.push({ item: { kind, id: `${kind}:lane-tools/${name}`, name, state: 'ready', detail: 'Declared for a lane; not found in an installed list on this machine.', lastChecked: at, usedByLanes: declaredFor(name), next: null } });
  }
  return entries;
}

function toolEntries(tools: ToolParityReport | null, registry: readonly RegistryFact[] | null, connectorIds: ReadonlySet<string>, at: string): Entry[] {
  const entries: Entry[] = [];
  if (!tools) entries.push(unread('tool', 'lane-tools', 'Lane tools'));
  else {
    const rows = new Map(tools.lanes.map(l => [l.lane, l]));
    const verdictFor = (need: ToolNeed) => (lane: string): Verdict => {
      const row = rows.get(lane);
      const value = row ? laneHas(row, need) : 'unknown';
      return value === 'yes' ? 'has' : value === 'no' ? 'lacks' : 'unknown';
    };
    const lanesWith = (need: ToolNeed, want: Verdict): string[] => tools.lanes.map(l => l.lane).filter(l => verdictFor(need)(l) === want);
    for (const need of TOOL_CAPABILITIES) {
      const has = lanesWith(need, 'has');
      const state: InventoryState = has.length ? 'ready' : lanesWith(need, 'lacks').length ? 'needs setup' : 'unknown';
      const label = toolLabel(need);
      entries.push({
        item: {
          kind: 'tool', id: `tool:${need}`, name: label, state,
          detail: state === 'ready' ? `${has.length} of ${plural(tools.lanes.length, 'lane')} ${has.length === 1 ? 'has' : 'have'} it.` : state === 'needs setup' ? 'No lane is known to have it.' : 'No source says which lanes have it.',
          lastChecked: at, usedByLanes: state === 'unknown' ? 'unknown' : has,
          next: state === 'needs setup' ? { text: `Give a lane ${label}, then record it in ${LANE_TOOLS_FILE}.`, command: 'phm tools parity' } : null,
        },
        verdict: verdictFor(need),
      });
    }
    // Named MCP servers and CLIs a lane declares. Ones from the connector profile are already listed as connectors.
    for (const need of tools.needs) {
      const name = /^(?:mcp|cli):(.+)$/.exec(need)?.[1];
      if (!name || connectorIds.has(name)) continue;
      const has = lanesWith(need, 'has');
      entries.push({
        item: { kind: 'tool', id: `tool:${need}`, name, state: 'ready', detail: `${toolLabel(need)}. Declared for ${plural(has.length, 'lane')}.`, lastChecked: at, usedByLanes: has, next: null },
        verdict: verdictFor(need),
      });
    }
  }
  if (!registry) entries.push(unread('tool', 'registry', 'Shared tool registry'));
  for (const t of registry ?? []) {
    const active = t.status === 'active';
    const what = t.kind === 'skill' ? 'Shared instruction template' : 'Shared connector call';
    const lanes = [...t.lanes];
    entries.push({
      item: {
        kind: 'tool', id: `tool:registry/${t.id}`, name: t.id, state: active ? 'ready' : 'off',
        detail: clip(`${what}${active ? '' : ', revoked'}. ${t.description}`), lastChecked: at, usedByLanes: lanes.length ? lanes : 'all', next: null,
      },
      // An empty lane list means every lane can find it. A revoked entry is off for everyone, so it is not compared.
      ...(active ? { verdict: (lane: string): Verdict => (!lanes.length || lanes.includes(lane) ? 'has' : 'lacks') } : {}),
    });
  }
  return entries;
}

/** Pure: join the five kinds into one list, count the states and compare the lanes. */
export function buildInventory(sources: InventorySources): Inventory {
  const at = sources.now.toISOString();
  const connectorIds = new Set((sources.connectors ?? []).map(c => c.id));
  const entries = [
    ...channelEntries(sources.channels),
    ...connectorEntries(sources.connectors, at),
    ...installedEntries('plugin', sources.plugins, sources.tools, at),
    ...installedEntries('skill', sources.skills, sources.tools, at),
    ...toolEntries(sources.tools, sources.registry, connectorIds, at),
  ];
  // Ids are the pane's keys and the parity's references: keep the first, number any repeat.
  const ids = new Map<string, number>();
  for (const { item } of entries) {
    const seen = ids.get(item.id) ?? 0;
    ids.set(item.id, seen + 1);
    if (seen) item.id = `${item.id}#${seen + 1}`;
  }
  const order = (kind: InventoryKind): number => INVENTORY_KINDS.indexOf(kind);
  entries.sort((a, b) => order(a.item.kind) - order(b.item.kind) || a.item.name.localeCompare(b.item.name) || a.item.id.localeCompare(b.item.id));
  const items = entries.map(e => e.item);

  const compared = entries.filter(e => e.verdict);
  const roster = sources.roster ?? ORG_LANES;
  const laneNames = [...roster, ...(sources.tools?.lanes ?? []).map(l => l.lane).filter(l => !roster.includes(l))];
  const lanes = laneNames.map(lane => {
    const has: string[] = [];
    const lacks: string[] = [];
    let unknown = 0;
    for (const e of compared) {
      const verdict = e.verdict!(lane);
      if (verdict === 'has') has.push(e.item.id); else if (verdict === 'lacks') lacks.push(e.item.id); else unknown++;
    }
    return { lane, has, lacks, unknown, gap: lacks.length };
  });
  const gaps = lanes.map(l => l.gap);

  return {
    schema: INVENTORY_SCHEMA, version: INVENTORY_VERSION, at, kind: null,
    counts: countStates(items),
    kinds: summarize(items, INVENTORY_KINDS),
    items,
    parity: { compared: compared.length, widestGap: gaps.length ? Math.max(...gaps) - Math.min(...gaps) : 0, lanes },
  };
}

function summarize(items: readonly InventoryItem[], kinds: readonly InventoryKind[]): Inventory['kinds'] {
  return kinds.map(kind => {
    const own = items.filter(i => i.kind === kind);
    return { kind, label: INVENTORY_KIND_LABELS[kind], total: own.length, counts: countStates(own) };
  });
}

/** Narrow to one kind: its items, its summary and its counts. Lane parity stays whole. */
export function filterInventory(inventory: Inventory, kind: InventoryKind): Inventory {
  const items = inventory.items.filter(i => i.kind === kind);
  return { ...inventory, kind, counts: countStates(items), kinds: summarize(items, [kind]), items };
}

/** Each reader fails on its own and its kind becomes unknown. Tests inject fixtures here instead of touching disk. */
export interface InventoryReaders {
  channels: () => Promise<ChannelsOverview>;
  connectors: () => Promise<ConnectorFact[]>;
  plugins: () => Promise<InstalledPanel> | InstalledPanel;
  skills: () => Promise<InstalledPanel> | InstalledPanel;
  tools: () => Promise<ToolParityReport>;
  registry: () => Promise<RegistryFact[]>;
}
export interface InventoryOptions { home?: string; runsDir?: string; now?: () => Date; readers?: Partial<InventoryReaders> }

/** Read every source, read-only, then build. Never throws: a failed read is reported as unknown. */
export async function readInventory(opts: InventoryOptions = {}): Promise<Inventory> {
  const now = opts.now ?? (() => new Date());
  const readers: InventoryReaders = {
    channels: async () => {
      const m = await import('./channels-overview.js');
      return m.readChannelsOverview(m.createDefaultChannelsReader({ now, ...(opts.home ? { homeDir: opts.home } : {}), ...(opts.runsDir ? { runsDir: opts.runsDir } : {}) }));
    },
    connectors: async () => {
      const [{ readProfile }, { executableAvailability }] = await Promise.all([import('../connectors/profile.js'), import('../connectors/mesh.js')]);
      const path = process.env.PATH ?? '';
      return Promise.all((await readProfile(opts.home)).connectors.map(async (c): Promise<ConnectorFact> => ({
        id: c.id, kind: c.kind, description: c.description ?? null, lanes: c.lanes, credentials: c.credentials.length,
        availability: c.command ? await executableAvailability(c.command, path) : 'unknown',
      })));
    },
    plugins: async () => (await import('./installed-panels.js')).readPluginsPanel({ now, ...(opts.home ? { home: opts.home } : {}) }),
    skills: async () => (await import('./installed-panels.js')).readSkillsPanel({ now, ...(opts.home ? { home: opts.home } : {}) }),
    tools: async () => (await import('./tool-parity.js')).loadToolParity({ ...(opts.runsDir ? { runsDir: opts.runsDir } : {}), ...(opts.home ? { home: opts.home } : {}) }),
    registry: async () => (await (await import('../connectors/registry.js')).readRegistry(opts.home)).tools,
    ...opts.readers,
  };
  const settle = async <T>(read: () => Promise<T> | T): Promise<T | null> => { try { return await read(); } catch { return null; } };
  const [channels, connectors, plugins, skills, tools, registry] = await Promise.all([
    settle(readers.channels), settle(readers.connectors), settle(readers.plugins), settle(readers.skills), settle(readers.tools), settle(readers.registry),
  ]);
  return buildInventory({ now: now(), channels, connectors, plugins, skills, tools, registry });
}

const MAX_ROWS = 40;

/** Plain text for `phm inventory`: the same rows the pane shows. */
export function formatInventory(inventory: Inventory): string {
  const states = (counts: InventoryCounts): string => INVENTORY_STATES.map(s => `${counts[s]} ${s}`).join(', ');
  const lines = [`Inventory: ${plural(inventory.items.length, 'item')}. ${states(inventory.counts)}.`];
  for (const summary of inventory.kinds) {
    lines.push('', `${summary.label} (${summary.total}): ${summary.total ? states(summary.counts) : 'none found'}`);
    const own = inventory.items.filter(i => i.kind === summary.kind);
    const width = Math.min(28, Math.max(0, ...own.slice(0, MAX_ROWS).map(i => i.name.length)));
    for (const item of own.slice(0, MAX_ROWS)) {
      lines.push(`  ${item.state.padEnd(12)} ${item.name.padEnd(width)}  ${item.detail}`);
      const { text, command } = item.next ?? { text: null, command: null };
      // The command is printed on its own only when the sentence does not already show it.
      if (text) lines.push(`               Next: ${text}${command && !text.includes(command) ? `  Run: ${command}` : ''}`);
    }
    if (own.length > MAX_ROWS) lines.push(`  … ${own.length - MAX_ROWS} more; see phm inventory --kind ${summary.kind} --json.`);
  }
  const { parity } = inventory;
  lines.push('', `Tool gap between lanes: ${parity.widestGap}. Each lane against ${parity.compared} tools and connectors.`);
  const width = Math.max(4, ...parity.lanes.map(l => l.lane.length)) + 2;
  for (const l of parity.lanes) lines.push(`  ${l.lane.padEnd(width)}can use ${l.has.length}, lacks ${l.gap}, unknown ${l.unknown}`);
  lines.push('unknown = no source says; it is never counted as lacking. One kind: phm inventory --kind <kind>. All fields: phm inventory --json');
  return lines.join('\n');
}
