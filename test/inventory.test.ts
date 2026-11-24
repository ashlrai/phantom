import { describe, expect, it } from 'vitest';
import type { ChannelOverviewRow, ChannelsOverview } from '../src/core/fleet/channels-schema.js';
import type { InstalledItem, InstalledPanel } from '../src/core/fleet/installed-panels.js';
import {
  INVENTORY_KINDS, INVENTORY_STATES, buildInventory, filterInventory, formatInventory, parseInventoryKind, readInventory,
  type ConnectorFact, type InventorySources, type RegistryFact,
} from '../src/core/fleet/inventory.js';
import { buildToolParity } from '../src/core/fleet/tool-parity.js';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const AT = NOW.toISOString();

const row = (channel: ChannelOverviewRow['channel'], label: string, state: ChannelOverviewRow['state'], over: Partial<ChannelOverviewRow> = {}): ChannelOverviewRow => ({
  channel, label, state, reason: null, lastInboundAt: null, lastOutboundAt: null, messages24h: 0, verifiedSenders: null, address: null, next: null, ...over,
});
const channels: ChannelsOverview = {
  schema: 'phantom.channels.v1', version: 1, at: '2026-11-18T11:59:00.000Z', counts: { connected: 1, 'not-set-up': 1, failing: 1, unknown: 1 },
  channels: [
    row('slack', 'Slack', 'failing', { reason: 'the bridge stopped', next: 'run `phm fleet channel-health` for the detail' }),
    row('imessage', 'iMessage', 'unknown', { reason: 'health could not be read', messages24h: 'unknown' }),
    row('telegram', 'Telegram', 'not-set-up', { next: 'add the bot with `phm channels add telegram`', address: '…1234' }),
    row('email', 'Email', 'connected', { messages24h: 3 }),
  ],
};
const connectors: ConnectorFact[] = [
  { id: 'docs', kind: 'mcp-stdio', description: 'Library docs.', lanes: ['claude', 'codex-local'], credentials: 0, availability: 'available' },
  { id: 'tracker', kind: 'cli', description: null, lanes: ['claude'], credentials: 2, availability: 'unavailable' },
  { id: 'remote', kind: 'mcp-http', description: 'Hosted search', lanes: [], credentials: 1, availability: 'unknown' },
];
const installed = (name: string, source: string, enabled: InstalledItem['enabled'], agents = 'Claude lanes'): InstalledItem => ({ name, source, agents, enabled, lastUsed: 'unknown' });
const plugins: InstalledPanel = {
  schema: 'fleet.plugins-panel.v1', observedAt: '2026-11-18T11:58:00.000Z',
  sources: [{ source: 'Phantom', state: 'read', count: 2 }, { source: 'Claude Code', state: 'unknown', count: 0 }],
  items: [installed('broken', 'Phantom', false, 'None (invalid manifest)'), installed('notes', 'Phantom', true, 'Any agent that runs phm on this machine')],
};
const skills: InstalledPanel = {
  schema: 'fleet.skills-panel.v1', observedAt: '2026-11-18T11:58:00.000Z',
  sources: [{ source: 'Claude Code', state: 'read', count: 2 }, { source: 'Codex', state: 'none', count: 0 }, { source: 'Learned from merged PRs', state: 'read', count: 2 }],
  items: [
    installed('review', 'Claude Code', true), installed('audit', 'Claude Code', 'unknown'),
    installed('fix-flaky-test', 'Learned from merged PRs', false, 'No lane yet (observe-only)'),
    installed('ship-small', 'Learned from merged PRs', true, 'No lane yet (observe-only)'),
  ],
};
/** claude has everything declared; codex-local declares a browser gap and an MCP list without `figma`; zai declares nothing. */
const tools = buildToolParity({
  lanes: ['claude', 'codex-local', 'zai'],
  sources: [{ name: 'lane-tools.json', lanes: {
    claude: { capabilities: { 'github-read': true, browser: true, 'computer-use': false }, mcp: ['docs', 'figma'], skill: ['review', 'deploy'] },
    'codex-local': { capabilities: { 'github-read': true, browser: false, 'computer-use': false }, mcp: ['docs'] },
  } }],
});
const registry: RegistryFact[] = [
  { id: 'triage', kind: 'skill', description: 'Sort new issues.', lanes: [], status: 'active' },
  { id: 'old-call', kind: 'connector-call', description: 'Retired call.', lanes: ['claude'], status: 'revoked' },
  { id: 'lookup', kind: 'connector-call', description: 'Find a ticket.', lanes: ['claude'], status: 'active' },
];
const full: InventorySources = { now: NOW, channels, connectors, plugins, skills, tools, registry, roster: ['claude', 'codex-local', 'zai'] };
const find = (id: string, sources: InventorySources = full) => buildInventory(sources).items.find(i => i.id === id);

describe('buildInventory', () => {
  it('lists the five kinds in order with a count per state', () => {
    const inv = buildInventory(full);
    expect(inv).toMatchObject({ schema: 'phantom.inventory.v1', version: 1, at: AT, kind: null });
    expect(inv.kinds.map(k => k.kind)).toEqual([...INVENTORY_KINDS]);
    expect(inv.kinds.map(k => [k.label, k.total])).toEqual([['Channels', 4], ['Connectors', 3], ['Plugins', 3], ['Skills', 5], ['Tools', 11]]);
    expect([...new Set(inv.items.map(i => i.kind))]).toEqual([...INVENTORY_KINDS]);
    expect(Object.keys(inv.counts)).toEqual([...INVENTORY_STATES]);
    expect(INVENTORY_STATES.reduce((sum, s) => sum + inv.counts[s], 0)).toBe(inv.items.length);
    for (const k of inv.kinds) expect(k.counts).toEqual(filterInventory(inv, k.kind).counts);
    expect(new Set(inv.items.map(i => i.id)).size).toBe(inv.items.length);
    // Every state appears, in the plain words.
    for (const state of INVENTORY_STATES) expect(inv.counts[state], state).toBeGreaterThan(0);
  });

  it('channels: connected is ready, not set up needs setup with one step, failing is error, unknown stays unknown', () => {
    expect(find('channel:email')).toEqual({ kind: 'channel', id: 'channel:email', name: 'Email', state: 'ready', detail: 'Connected. 3 messages in the last 24 hours.', lastChecked: channels.at, usedByLanes: [], next: null });
    expect(find('channel:telegram')).toMatchObject({ state: 'needs setup', detail: 'Not set up yet.', next: { text: 'add the bot with `phm channels add telegram`', command: 'phm channels add telegram' } });
    expect(find('channel:slack')).toMatchObject({ state: 'error', detail: 'the bridge stopped', next: { command: 'phm fleet channel-health' } });
    expect(find('channel:imessage')).toMatchObject({ state: 'unknown', detail: 'health could not be read', next: null });
    // A channel that needs setup always names a step, even when its source gave none.
    const bare = { ...full, channels: { ...channels, channels: [row('telegram', 'Telegram', 'not-set-up')] } };
    expect(find('channel:telegram', bare)!.next).toEqual({ text: 'Set this channel up.', command: 'phm channels' });
    // A step that is itself a command is the command to copy; a step with no command has none.
    const stepFor = (next: string) => find('channel:telegram', { ...full, channels: { ...channels, channels: [row('telegram', 'Telegram', 'not-set-up', { next })] } })!.next;
    expect(stepFor('phm channels add telegram <chat-id> — the bot is named in the config')).toMatchObject({ command: 'phm channels add telegram <chat-id>' });
    expect(stepFor('phm channels add email <inboxDir> --from <address>')).toMatchObject({ command: 'phm channels add email <inboxDir> --from <address>' });
    expect(stepFor('the phone gateway needs a config file, see docs/REMOTE-PHONE.md')).toMatchObject({ command: null });
  });

  it('connectors: on PATH is ready, missing program needs setup, unchecked endpoint is unknown; credentials are counted, never shown', () => {
    expect(find('connector:docs')).toEqual({ kind: 'connector', id: 'connector:docs', name: 'docs', state: 'ready', detail: 'MCP server on this machine. Library docs.', lastChecked: AT, usedByLanes: ['claude', 'codex-local'], next: null });
    expect(find('connector:tracker')).toMatchObject({
      state: 'needs setup', usedByLanes: ['claude'],
      detail: 'CLI. Its program is not on PATH. Lists 2 credential names; whether each is set is not checked here.',
      next: { text: 'Install its program so it is on PATH, then check it again.', command: 'phm connectors show tracker' },
    });
    expect(find('connector:remote')).toMatchObject({ state: 'unknown', usedByLanes: [], next: null });
    expect(find('connector:remote')!.detail).toContain('No lane is listed, so no lane can run it.');
  });

  it('plugins and skills: on is ready, off is off, a bad manifest is error, unknown stays unknown', () => {
    expect(find('plugin:Phantom/notes')).toMatchObject({ state: 'ready', detail: 'Phantom. Any agent that runs phm on this machine.', lastChecked: plugins.observedAt, usedByLanes: 'unknown' });
    expect(find('plugin:Phantom/broken')).toMatchObject({ state: 'error', detail: 'Phantom. Its manifest is not valid, so nothing loads it.' });
    expect(find('skill:Claude Code/audit')).toMatchObject({ state: 'unknown', usedByLanes: 'unknown' });
    // A lane that declares the skill is named; a learned card is handed to no lane yet.
    expect(find('skill:Claude Code/review')).toMatchObject({ state: 'ready', usedByLanes: ['claude'] });
    expect(find('skill:Learned from merged PRs/fix-flaky-test')).toMatchObject({ state: 'off', usedByLanes: [] });
    expect(find('skill:Learned from merged PRs/ship-small')).toMatchObject({ state: 'ready', usedByLanes: [] });
    // Declared for a lane but in no installed list: still listed, once.
    expect(find('skill:lane-tools/deploy')).toMatchObject({ state: 'ready', usedByLanes: ['claude'] });
  });

  it('tools: some lane has it is ready, no lane has it needs setup, undeclared is unknown, revoked is off', () => {
    expect(find('tool:github-read')).toMatchObject({ name: 'GitHub read', state: 'ready', detail: '2 of 3 lanes have it.', usedByLanes: ['claude', 'codex-local'] });
    expect(find('tool:browser')).toMatchObject({ state: 'ready', detail: '1 of 3 lanes has it.', usedByLanes: ['claude'] });
    expect(find('tool:computer-use')).toMatchObject({
      state: 'needs setup', detail: 'No lane is known to have it.', usedByLanes: [],
      next: { text: 'Give a lane Computer use, then record it in <runs>/queue/lane-tools.json.', command: 'phm tools parity' },
    });
    expect(find('tool:shell')).toMatchObject({ state: 'unknown', detail: 'No source says which lanes have it.', usedByLanes: 'unknown', next: null });
    expect(find('tool:mcp:figma')).toMatchObject({ name: 'figma', state: 'ready', detail: 'MCP server figma. Declared for 1 lane.', usedByLanes: ['claude'] });
    // `docs` is a connector, so it is not listed a second time as a tool.
    expect(find('tool:mcp:docs')).toBeUndefined();
    expect(find('tool:registry/triage')).toMatchObject({ state: 'ready', detail: 'Shared instruction template. Sort new issues.', usedByLanes: 'all' });
    expect(find('tool:registry/old-call')).toMatchObject({ state: 'off', detail: 'Shared connector call, revoked. Retired call.' });
  });

  it('a missing source yields unknown rows, never a guess', () => {
    const inv = buildInventory({ now: NOW, channels: null, connectors: null, plugins: null, skills: null, tools: null, registry: null, roster: ['claude'] });
    expect(inv.items.map(i => [i.id, i.name])).toEqual([
      ['channel:channels', 'Messaging channels'], ['connector:profile', 'Connector profile'], ['plugin:installed', 'Installed plugins'],
      ['skill:installed', 'Installed skills'], ['tool:lane-tools', 'Lane tools'], ['tool:registry', 'Shared tool registry'],
    ]);
    for (const item of inv.items) expect(item).toMatchObject({ state: 'unknown', detail: 'Could not read this source.', lastChecked: null, usedByLanes: 'unknown', next: null });
    expect(inv.counts).toEqual({ ready: 0, 'needs setup': 0, off: 0, error: 0, unknown: 6 });
    // Nothing to compare, so no lane is said to lack anything.
    expect(inv.parity).toEqual({ compared: 0, widestGap: 0, lanes: [{ lane: 'claude', has: [], lacks: [], unknown: 0, gap: 0 }] });
    // One unreadable list inside a panel that was read is also a row.
    expect(find('plugin:Claude Code/?')).toMatchObject({ name: 'Claude Code plugins', state: 'unknown' });
    // An empty source is not unknown: it simply has no rows.
    const empty = buildInventory({ ...full, connectors: [], registry: [] });
    expect(empty.kinds.find(k => k.kind === 'connector')).toMatchObject({ total: 0, counts: { unknown: 0 } });
  });

  it('lane parity: what each lane can use and lacks, with the gap as a number', () => {
    const { parity } = buildInventory(full);
    // 3 connectors + 7 capabilities + figma + 2 active registry tools; the revoked one is off for everyone.
    expect(parity.compared).toBe(13);
    expect(parity.lanes.map(l => [l.lane, l.has.length, l.gap, l.unknown])).toEqual([['claude', 7, 2, 4], ['codex-local', 3, 6, 4], ['zai', 1, 4, 8]]);
    expect(parity.widestGap).toBe(4);
    const local = parity.lanes[1]!;
    expect(local.has).toEqual(['connector:docs', 'tool:github-read', 'tool:registry/triage']);
    expect([...local.lacks].sort()).toEqual(['connector:tracker', 'connector:remote', 'tool:browser', 'tool:computer-use', 'tool:mcp:figma', 'tool:registry/lookup'].sort());
    for (const lane of parity.lanes) expect(lane.has.length + lane.lacks.length + lane.unknown).toBe(parity.compared);
    // Lanes a source names come after the roster.
    expect(buildInventory({ ...full, roster: ['zai'] }).parity.lanes.map(l => l.lane)).toEqual(['zai', 'claude', 'codex-local']);
  });

  it('filters to one kind and keeps the lane parity whole', () => {
    const inv = buildInventory(full);
    const one = filterInventory(inv, 'connector');
    expect(one.kind).toBe('connector');
    expect(one.items.map(i => i.id)).toEqual(['connector:docs', 'connector:remote', 'connector:tracker']);
    expect(one.kinds).toEqual([{ kind: 'connector', label: 'Connectors', total: 3, counts: { ready: 1, 'needs setup': 1, off: 0, error: 0, unknown: 1 } }]);
    expect(one.counts).toEqual(one.kinds[0]!.counts);
    expect(one.parity).toEqual(inv.parity);
    expect(parseInventoryKind('Skills')).toBe('skill');
    expect(parseInventoryKind('channel')).toBe('channel');
    expect(parseInventoryKind('secrets')).toBeNull();
  });

  it('prints the same rows as plain text', () => {
    const text = formatInventory(buildInventory(full));
    expect(text.split('\n')[0]).toBe('Inventory: 26 items. 11 ready, 3 needs setup, 2 off, 2 error, 8 unknown.');
    expect(text).toContain('Connectors (3): 1 ready, 1 needs setup, 0 off, 0 error, 1 unknown');
    expect(text).toContain('Next: Install its program so it is on PATH, then check it again.  Run: phm connectors show tracker');
    expect(text).toContain('Next: add the bot with `phm channels add telegram`\n');
    expect(text).toContain('Tool gap between lanes: 4. Each lane against 13 tools and connectors.');
    expect(text).toMatch(/codex-local\s+can use 3, lacks 6, unknown 4/);
    expect(formatInventory(filterInventory(buildInventory({ ...full, connectors: [] }), 'connector'))).toContain('Connectors (0): none found');
  });
});

describe('readInventory', () => {
  it('reads each source on its own: a reader that throws becomes unknown, the rest still list', async () => {
    const inv = await readInventory({
      now: () => NOW,
      readers: {
        channels: async () => channels, connectors: async () => { throw new Error('unreadable'); },
        plugins: () => plugins, skills: () => skills, tools: async () => tools, registry: async () => registry,
      },
    });
    expect(inv.at).toBe(AT);
    expect(inv.items.find(i => i.kind === 'connector')).toMatchObject({ id: 'connector:profile', state: 'unknown' });
    expect(inv.kinds.find(k => k.kind === 'channel')!.total).toBe(4);
  });
});
