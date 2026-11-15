import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool } from '../src/core/mcp-native.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { parseInbox } from '../src/core/fleet/mason-inbox.js';
import { readDelivery } from '../src/core/fleet/needs-mason-reply-delivery.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));

const NEEDS = 'phantom_fleet_needs';
const RESOLVE = 'phantom_fleet_needs_resolve';
const ITEM_TEXT = 'Pick a fictional relay colour';
const ORIGINAL_REPLY = 'Choose imaginary teal';
const REPLAY_REPLY = 'Choose imaginary green';

let home = '';
let runs = '';
let busRoot = '';

const needsPath = () => join(runs, 'NEEDS-MASON.md');
const inboxPath = () => join(runs, 'leader', 'MASON-INBOX.md');
const busBodies = (): Record<string, unknown>[] => {
  const page = listBusInboxAfter(0, 100, { root: busRoot });
  return page.status === 'ok' ? page.messages.map(message => message.envelope.body as Record<string, unknown>) : [];
};
const call = async (name: string, args: unknown) => {
  const result = await callNativeTool(name, args);
  return { result, text: result.content[0]!.text };
};
const inboxText = () => readFileSync(inboxPath(), 'utf8');
const inboxEntries = () => parseInbox(inboxText());
const resolvedMarkers = () => readFileSync(needsPath(), 'utf8').match(/- \[x\] resolved nm-/g)?.length ?? 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'needs-mcp-replay-'));
  runs = join(home, 'runs-env');
  busRoot = join(home, 'ashlr-home', 'fleet');
  vi.stubEnv('HOME', home);
  vi.stubEnv('ASHLR_HOME', join(home, 'ashlr-home'));
  vi.stubEnv('ASHLR_RUNS_DIR', runs);
  mkdirSync(runs, { recursive: true });
  writeFileSync(needsPath(), `# Needs Mason\n- [ ] ${ITEM_TEXT}\n`);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

async function listedItemId(): Promise<string> {
  const { result, text } = await call(NEEDS, {});
  expect(result.isError).toBeFalsy();
  const { items } = JSON.parse(text) as { items: { id: string; text: string }[] };
  expect(items).toHaveLength(1);
  expect(items[0]!.text).toBe(ITEM_TEXT);
  return items[0]!.id;
}

describe('phantom_fleet_needs_resolve agent-attributed replay', () => {
  it('replays a pending inbox delivery with the original agent-attributed reply and no second resolution', async () => {
    const itemId = await listedItemId();
    // Real append failure: `leader` exists as a file, so MASON-INBOX.md cannot be
    // created beneath it. The relay, bus and inbox are all the production path.
    writeFileSync(join(runs, 'leader'), 'not a directory');
    const first = await call(RESOLVE, { itemId, reply: ORIGINAL_REPLY });
    expect(first.result.isError).toBeFalsy();
    expect(JSON.parse(first.text)).toMatchObject({ v: 1, status: 'resolved', itemId, duplicate: false, inbox: 'failed' });
    // The durable resolution already landed on the bus, attributed to the agent surface.
    expect(busBodies()).toEqual([expect.objectContaining({
      kind: 'needs_mason.resolved', itemId, source: 'leader', item: ITEM_TEXT, reply: ORIGINAL_REPLY,
    })]);
    expect(existsSync(inboxPath())).toBe(false);

    // Replay the same item through the MCP handler carrying different reply text:
    // the persisted pending delivery wins, so the original answer is what lands.
    rmSync(join(runs, 'leader'));
    const replay = await call(RESOLVE, { itemId, reply: REPLAY_REPLY });
    expect(replay.result.isError).toBeFalsy();
    expect(JSON.parse(replay.text)).toMatchObject({ status: 'resolved', itemId, inbox: 'appended' });

    // Still exactly one durable resolution, still agent-sourced, still the original reply.
    const bodies = busBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ kind: 'needs_mason.resolved', itemId, source: 'leader', reply: ORIGINAL_REPLY });
    expect(bodies[0]!['source']).not.toBe('cli');
    expect(bodies[0]!['source']).not.toBe('desktop');
    expect(JSON.stringify(bodies)).not.toContain(REPLAY_REPLY);

    // Exactly one planner inbox answer on the unverified-agent channel; the
    // replayed text never claims Mason's CLI or desktop surface.
    const text = inboxText();
    const inbox = parseInbox(text);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      channel: 'agent-via-mcp-unverified',
      text: `Re needs-you ${itemId} ("${ITEM_TEXT}"): ${ORIGINAL_REPLY}`,
    });
    expect(inbox[0]!.source).toContain('agent-via-mcp-unverified');
    expect(text).toContain('[src:agent-via-mcp-unverified');
    expect(text).not.toContain('[src:cli');
    expect(text).not.toContain('[src:desktop');
    expect(text).not.toContain(REPLAY_REPLY);
    expect(readFileSync(join(runs, 'dispatch-events.log'), 'utf8')).toContain('INBOX new entry from Agent via MCP unverified');

    // The delivery settled and the raw reply is not retained in the state file.
    expect(readDelivery(runs, itemId)).toMatchObject({ kind: 'state', state: { status: 'delivered', message: '' } });
    expect(resolvedMarkers()).toBe(1);
  });

  it('refuses a post-delivery replay with different text: one resolution, one answer, original intact', async () => {
    const itemId = await listedItemId();
    const first = await call(RESOLVE, { itemId, reply: ORIGINAL_REPLY });
    expect(first.result.isError).toBeFalsy();
    expect(JSON.parse(first.text)).toMatchObject({ status: 'resolved', itemId, inbox: 'appended' });

    const replay = await call(RESOLVE, { itemId, reply: REPLAY_REPLY });
    expect(replay.result.isError).toBe(true);
    expect(JSON.parse(replay.text)).toMatchObject({ status: 'already-resolved', itemId, inbox: 'skipped' });

    expect(busBodies()).toHaveLength(1);
    expect(busBodies()[0]).toMatchObject({ kind: 'needs_mason.resolved', source: 'leader', reply: ORIGINAL_REPLY });
    const inbox = inboxEntries();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      channel: 'agent-via-mcp-unverified',
      text: `Re needs-you ${itemId} ("${ITEM_TEXT}"): ${ORIGINAL_REPLY}`,
    });
    expect(inboxText()).not.toContain(REPLAY_REPLY);
    expect(resolvedMarkers()).toBe(1);
  });
});
