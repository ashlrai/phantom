/**
 * connect-list.ts: everything the fleet can plug into, as one typed list for
 * `phm fleet connect list`.
 *
 * It owns no store. Every row is projected from a reader that already backs
 * another surface: `phm channels`, the gateway connector manager, the
 * connector profile mesh, `phm plugins|skills list --all`, `phm tools` and
 * the tool registry. Read-only; a source that cannot be read
 * puts its kind in `unread` and a state nobody measured stays 'unknown'.
 * Credentials are never read: a row only says that it needs sign-in.
 */
import { stripVTControlCharacters } from 'node:util';
import { scrubSecrets } from '../util/scrub-secrets.js';
import type { ChannelsOverview, Unknowable } from './channels-schema.js';
import {
  CONNECT_KIND_LABEL, CONNECT_KINDS, CONNECT_SCHEMA, CONNECT_STATES, CONNECT_TOGGLE_PATH, CONNECT_VERSION,
  isConnectKind, type ConnectKind, type ConnectList, type ConnectRow, type ConnectState,
} from './connect-schema.js';
import { INVALID_MANIFEST_AGENTS, type InstalledPanel } from './installed-panels.js';
import type { ToolMatrix } from './tool-parity.js';

export * from './connect-schema.js';

/** One injectable read per existing source; each may throw. */
export interface ConnectReaders {
  /** `phm channels` overview, plus the channels whose credential is missing. */
  channels: () => Promise<{ overview: ChannelsOverview; needSignIn: readonly string[] }>;
  /** Gateway registry (the Connectors settings list): the only source with a toggle. */
  gateway: () => Promise<{ revision: string; connectors: ReadonlyArray<{ name: string; enabled: boolean }> }>;
  /** Connector profile entries as `phm connectors mesh` reports them. */
  profile: () => Promise<ReadonlyArray<{ id: string; availability: 'available' | 'unavailable' | 'unknown'; lanes: readonly string[]; needsCredential: boolean }>>;
  plugins: () => InstalledPanel | Promise<InstalledPanel>;
  skills: () => InstalledPanel | Promise<InstalledPanel>;
  /** `phm tools` matrix. */
  tools: () => Promise<ToolMatrix | null>;
  /** Agent-made tools (`phm connectors tool list`, revoked ones included). */
  registry: () => Promise<ReadonlyArray<{ id: string; status: 'active' | 'revoked'; lanes: readonly string[] }>>;
}

export function defaultConnectReaders(): ConnectReaders {
  return {
    channels: async () => {
      const { buildChannelsOverview, createDefaultChannelsReader } = await import('./channels-overview.js');
      const facts = await createDefaultChannelsReader()();
      return { overview: buildChannelsOverview(facts), needSignIn: facts.status.channels.filter(c => c.credential === 'missing').map(c => c.kind) };
    },
    gateway: async () => (await import('../verse/connector-manager.js')).listConnectors(),
    profile: async () => (await (await import('../connectors/mesh.js')).buildToolMesh()).connectors.map(c => ({
      id: c.id, availability: c.availability, lanes: c.permissions.lanes, needsCredential: c.permissions.credentialBindings.length > 0,
    })),
    plugins: async () => (await import('./installed-panels.js')).readPluginsPanel(),
    skills: async () => (await import('./installed-panels.js')).readSkillsPanel(),
    tools: async () => { const t = await import('./tool-parity.js'); return t.buildToolMatrix(await t.loadToolParity()); },
    registry: async () => (await (await import('../connectors/registry.js')).readRegistry()).tools,
  };
}

// Strip terminal escapes and control/bidi characters before the shared scrubber.
const text = (value: string, cap = 240): string => scrubSecrets(stripVTControlCharacters(value)
  .replace(/[\s\S]/gu, char => {
    const code = char.codePointAt(0)!;
    return code < 32 || code >= 127 && code <= 159 || code >= 0x202a && code <= 0x202e
      || code >= 0x2066 && code <= 0x2069 ? ' ' : char;
  })).replace(/\s+/g, ' ').trim().slice(0, cap);
const byName = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const lastUsed = (value: ConnectRow['lastUsed'] | undefined): ConnectRow['lastUsed'] =>
  value === null ? null : typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value)
    && Number.isFinite(Date.parse(value)) ? value : 'unknown';
const MAX_SOURCE_ROWS = 256;
type Draft = Omit<ConnectRow, 'id' | 'kind' | 'needsSignIn' | 'toggle' | 'lastUsed'> & Partial<Pick<ConnectRow, 'needsSignIn' | 'toggle' | 'lastUsed'>>;
/** A source's rows; `partial` when part of the source could not be read. */
type Part = { rows: Draft[]; partial?: boolean };

/** Newest of the two channel times; 'unknown' unless a time or two nevers were measured. */
function newest(a: Unknowable<string | null>, b: Unknowable<string | null>): ConnectRow['lastUsed'] {
  const times = [a, b].filter((v): v is string => v !== null && v !== 'unknown').sort();
  if (times.length) return times[times.length - 1]!;
  return a === null && b === null ? null : 'unknown';
}

const CHANNEL_STATE = { connected: 'on', 'not-set-up': 'off', failing: 'broken', unknown: 'unknown' } as const;

function installed(panel: InstalledPanel, next: (item: InstalledPanel['items'][number], state: ConnectState) => string): Part {
  return { partial: panel.sources.some(s => s.state === 'unknown'), rows: panel.items.map((item) => {
    const state: ConnectState = item.enabled === 'unknown' ? 'unknown' : item.enabled ? 'on' : item.agents === INVALID_MANIFEST_AGENTS ? 'broken' : 'off';
    return { name: item.name, source: item.source, state, lastUsed: item.lastUsed, users: state === 'broken' ? [] : [item.agents], next: next(item, state) };
  }) };
}

const SOURCES: ReadonlyArray<[ConnectKind, (r: ConnectReaders) => Promise<Part>]> = [
  ['channel', async (r) => {
    const { overview, needSignIn } = await r.channels();
    return { rows: overview.channels.map((c) => ({
      name: c.label, source: 'Phantom', state: CHANNEL_STATE[c.state], lastUsed: newest(c.lastInboundAt, c.lastOutboundAt),
      users: ['Owner', 'Leader'], needsSignIn: c.state !== 'connected' && needSignIn.includes(c.channel),
      next: c.next ?? c.reason ?? 'Run `phm channels` for the detail.',
    })) };
  }],
  ['connector', async (r) => {
    const { revision, connectors } = await r.gateway();
    return { rows: connectors.map(c => ({
      name: c.name, source: 'Gateway', state: c.enabled ? 'on' as const : 'off' as const, users: ['Gateway clients'],
      next: 'Turn it on, then restart gateway clients.', toggle: { path: CONNECT_TOGGLE_PATH, revision },
    })) };
  }],
  ['connector', async r => ({ rows: (await r.profile()).map((c) => {
    const state: ConnectState = c.availability === 'unavailable' ? 'broken' : c.availability === 'unknown' || c.needsCredential ? 'unknown' : 'on';
    return {
      name: c.id, source: 'Connector profile', state, users: [...c.lanes], needsSignIn: c.needsCredential,
      next: state === 'broken' ? `Its command was not found. Install it, or run \`phm connectors remove ${c.id}\`.`
        : c.needsCredential ? 'Sign-in is not checked here. Import the credential with `phantom import` in a trusted terminal.'
          : `Not checked yet. See \`phm connectors show ${c.id}\`.`,
    };
  }) })],
  ['plugin', async r => installed(await r.plugins(), (item, state) => state === 'broken' ? 'Fix its manifest.json, or remove the plugin folder.'
    : state === 'unknown' ? 'Could not tell. Check `phm plugins list --all`.'
      : item.source === 'Phantom' ? `Run \`phm plugins enable ${text(item.name, 160)}\`.` : 'Turn it on in Claude Code with `/plugin`.')],
  ['skill', async r => installed(await r.skills(), (_item, state) => state === 'unknown' ? 'Could not tell. Check `phm skills list --all`.'
    : 'It turns on once its checks pass. See `phm skills list`.')],
  ['tool', async (r) => {
    const matrix = await r.tools();
    if (!matrix) return { rows: [], partial: true };
    // Named rows (mcp:, cli:, skill:, plugin:) already appear under their own kind.
    return { partial: matrix.sources.some(s => s.state === 'degraded'), rows: matrix.rows.filter(row => row.kind === 'capability').map((row) => {
      const has = (value: string) => matrix.lanes.filter(lane => row.cells[lane]?.value === value);
      const users = has('yes');
      const state: ConnectState = users.length ? 'on' : has('unknown').length || !matrix.lanes.length ? 'unknown' : 'off';
      return { name: row.label, source: 'Lane tools', state, users,
        next: matrix.topGaps.find(g => g.need === row.need)?.fix ?? (state === 'off' ? 'No lane has it. See `phm tools`.' : 'No source says which lane has it. See `phm tools`.') };
    }) };
  }],
  ['tool', async r => ({ rows: (await r.registry()).map(t => ({
    name: t.id, source: 'Tool registry', state: t.status === 'active' ? 'on' as const : 'off' as const,
    users: t.lanes.length ? [...t.lanes] : ['Any lane'], next: 'Revoked. Make it again with `phm connectors tool create`.',
  })) })],
];

const STATE_ORDER: Record<ConnectState, number> = { broken: 0, unknown: 1, off: 2, on: 3 };

export async function buildConnectList(opts: { kind?: ConnectKind; readers?: Partial<ConnectReaders>; now?: () => Date } = {}): Promise<ConnectList> {
  if (opts.kind !== undefined && !isConnectKind(opts.kind)) throw new Error('Invalid connection kind');
  const readers = { ...defaultConnectReaders(), ...opts.readers };
  const picked = SOURCES.filter(([kind]) => !opts.kind || kind === opts.kind);
  const parts = await Promise.all(picked.map(async ([kind, read]) => {
    try {
      const part = await read(readers);
      return { kind, rows: part.rows.sort((a, b) => byName(text(a.name), text(b.name)) || byName(text(a.source), text(b.source)) || byName(JSON.stringify(a), JSON.stringify(b))).slice(0, MAX_SOURCE_ROWS), partial: part.partial || part.rows.length > MAX_SOURCE_ROWS };
    } catch { return { kind, rows: [], partial: true }; }
  }));
  const rows = parts.flatMap(({ kind, rows: drafts }) => drafts.map((d): ConnectRow => ({
    id: `${kind}:${text(d.source)}:${text(d.name)}`, name: text(d.name, 160), kind, source: text(d.source), state: d.state,
    lastUsed: lastUsed(d.lastUsed), users: [...new Set(d.users.map(u => text(u, 80)).filter(Boolean))].sort(byName).slice(0, 24),
    needsSignIn: d.needsSignIn === true, next: d.state === 'on' ? null : text(d.next ?? ''), toggle: d.toggle && /^[a-f0-9]{40}$/.test(d.toggle.revision) ? d.toggle : null,
  })));
  rows.sort((a, b) => CONNECT_KINDS.indexOf(a.kind) - CONNECT_KINDS.indexOf(b.kind) || STATE_ORDER[a.state] - STATE_ORDER[b.state] || byName(a.name, b.name) || byName(a.id, b.id) || byName(JSON.stringify(a), JSON.stringify(b)));
  return {
    schema: CONNECT_SCHEMA, version: CONNECT_VERSION, at: (opts.now?.() ?? new Date()).toISOString(), kind: opts.kind ?? null,
    counts: Object.fromEntries(CONNECT_STATES.map(s => [s, rows.filter(row => row.state === s).length])) as Record<ConnectState, number>,
    unread: CONNECT_KINDS.filter(kind => parts.some(p => p.kind === kind && p.partial)),
    rows,
  };
}

/** Plain text for the CLI; the same rows the pane shows. */
export function formatConnectList(list: ConnectList): string {
  const lines = [`Connect: ${CONNECT_STATES.map(s => `${list.counts[s]} ${s}`).join(' · ')}.`];
  for (const kind of list.kind ? [list.kind] : CONNECT_KINDS) {
    const rows = list.rows.filter(row => row.kind === kind);
    lines.push(`${CONNECT_KIND_LABEL[kind]}${list.unread.includes(kind) ? ' (some could not be read: unknown)' : ''}`);
    if (!rows.length) lines.push(list.unread.includes(kind) ? '  unavailable' : '  none found');
    for (const row of rows) {
      const used = row.lastUsed === null ? 'never' : row.lastUsed;
      lines.push(`  ${row.state.padEnd(9)}${row.name}  [${row.source}]  used by: ${row.users.join(', ') || 'no one named'}  last used: ${used}${row.needsSignIn ? '  needs sign-in' : ''}`);
      if (row.next) lines.push(`           next: ${row.next.replace(/`/g, '')}`);
    }
  }
  return lines.join('\n');
}
