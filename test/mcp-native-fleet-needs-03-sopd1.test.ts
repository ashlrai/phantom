import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { parseInbox } from '../src/core/fleet/mason-inbox.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));

const NEEDS = 'phantom_fleet_needs';
const RESOLVE = 'phantom_fleet_needs_resolve';
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
const listedItems = async (): Promise<{ id: string; text: string }[]> =>
  (JSON.parse((await call(NEEDS, {})).text) as { items: { id: string; text: string }[] }).items;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'needs-mcp-'));
  runs = join(home, 'runs-env');
  busRoot = join(home, 'ashlr-home', 'fleet');
  vi.stubEnv('HOME', home);
  vi.stubEnv('ASHLR_HOME', join(home, 'ashlr-home'));
  vi.stubEnv('ASHLR_RUNS_DIR', runs);
  mkdirSync(runs, { recursive: true });
  writeFileSync(needsPath(), '# Needs Mason\n- [ ] Approve the fake deploy\n- Pick a fake vendor\n- [x] already done\n');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('registration', () => {
  it('advertises a read list tool and an append resolve tool with closed schemas', () => {
    expect(nativeToolSafety(NEEDS)).toBe('read');
    expect(nativeToolSafety(RESOLVE)).toBe('append');
    const listed = listNativeTools();
    expect(listed.find(tool => tool.name === NEEDS)).toMatchObject({
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    });
    const resolveTool = listed.find(tool => tool.name === RESOLVE);
    expect(resolveTool).toMatchObject({
      inputSchema: { type: 'object', required: ['itemId'], additionalProperties: false,
        properties: { itemId: { type: 'string', pattern: '^nm-[0-9a-f]{12}$' }, reply: { type: 'string' } } },
    });
    // Resolution records an answer Mason already gave; it never licenses the
    // agent to invent one on his behalf.
    expect(resolveTool!.description).toContain("Mason's");
    expect(resolveTool!.description).toMatch(/never permission|never an answer/i);
  });
});

describe('phantom_fleet_needs', () => {
  it('lists the open fake items through the real call path as bounded id/text records', async () => {
    const { result, text } = await call(NEEDS, {});
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(text) as { v: number; count: number; items: { id: string; text: string }[] };
    expect(body).toMatchObject({ v: 1, count: 2 });
    expect(body.items).toHaveLength(2);
    expect(body.items[0]!.id).toMatch(/^nm-[0-9a-f]{12}$/);
    expect(body.items.map(item => item.text)).toEqual(['Approve the fake deploy', 'Pick a fake vendor']);
  });

  it('honours the homedir default runs root when ASHLR_RUNS_DIR is unset', async () => {
    delete process.env['ASHLR_RUNS_DIR'];
    runs = join(home, '.ashlr-runs');
    mkdirSync(runs, { recursive: true });
    writeFileSync(needsPath(), '- [ ] Default-root fake item\n');
    const body = JSON.parse((await call(NEEDS, {})).text) as { items: { text: string }[] };
    expect(body.items.map(item => item.text)).toEqual(['Default-root fake item']);
  });

  it.each([{ runsDir: '/tmp/fake' }, { extra: 1 }, { limit: 2 }, [], 'x'])(
    'rejects %j without reading anything', async args => {
      const { result, text } = await call(NEEDS, args);
      expect(result.isError).toBe(true);
      expect(text).toContain('invalid needs arguments');
    });

  it('never accepts a client-supplied path: a foreign runs dir stays unread', async () => {
    const foreign = mkdtempSync(join(tmpdir(), 'needs-foreign-'));
    writeFileSync(join(foreign, 'NEEDS-MASON.md'), '- [ ] Foreign fake item\n');
    const { result } = await call(NEEDS, { runsDir: foreign });
    expect(result.isError).toBe(true);
    expect((await listedItems()).map(item => item.text)).toEqual(['Approve the fake deploy', 'Pick a fake vendor']);
    rmSync(foreign, { recursive: true, force: true });
  });
});

describe('phantom_fleet_needs_resolve', () => {
  it('resolves a listed item: durable bus event, file marker and planner inbox entry', async () => {
    const [item] = await listedItems();
    const { result, text } = await call(RESOLVE, { itemId: item!.id, reply: 'Ship the fake deploy Friday' });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body).toMatchObject({ v: 1, status: 'resolved', itemId: item!.id, duplicate: false, inbox: 'appended' });
    expect(typeof body['cursor']).toBe('number');
    // The actual durable bus resolution, source 'cli' like the existing CLI surface.
    expect(busBodies()).toEqual([expect.objectContaining({
      kind: 'needs_mason.resolved', itemId: item!.id, source: 'cli',
      item: 'Approve the fake deploy', reply: 'Ship the fake deploy Friday',
    })]);
    // The marker line so the item stops listing.
    expect(readFileSync(needsPath(), 'utf8')).toContain(`- [x] resolved ${item!.id}`);
    expect((await listedItems()).map(entry => entry.text)).toEqual(['Pick a fake vendor']);
    // The planner inbox received Mason's answer on the cli channel.
    const inbox = parseInbox(readFileSync(inboxPath(), 'utf8'));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ channel: 'cli' });
    expect(inbox[0]!.text).toBe(`Re needs-you ${item!.id} ("Approve the fake deploy"): Ship the fake deploy Friday`);
  });

  it('skips the inbox when no reply is given and says so', async () => {
    const [item] = await listedItems();
    const { result, text } = await call(RESOLVE, { itemId: item!.id });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text)).toMatchObject({ status: 'resolved', inbox: 'skipped' });
    expect(existsSync(inboxPath())).toBe(false);
    expect(busBodies()).toHaveLength(1);
    expect(busBodies()[0]).not.toHaveProperty('reply');
  });

  it('repeated resolution returns the existing refusal with no extra bus or inbox writes', async () => {
    const [item] = await listedItems();
    await call(RESOLVE, { itemId: item!.id, reply: 'first answer' });
    const { result, text } = await call(RESOLVE, { itemId: item!.id, reply: 'second answer' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ status: 'already-resolved', itemId: item!.id, inbox: 'skipped' });
    expect(busBodies()).toHaveLength(1);
    expect(parseInbox(readFileSync(inboxPath(), 'utf8'))).toHaveLength(1);
  });

  it('refuses an unknown id with the existing code and writes nothing', async () => {
    const { result, text } = await call(RESOLVE, { itemId: 'nm-000000000000', reply: 'fake answer' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ status: 'unknown', itemId: 'nm-000000000000', inbox: 'skipped' });
    expect(busBodies()).toEqual([]);
    expect(existsSync(inboxPath())).toBe(false);
    expect(readFileSync(needsPath(), 'utf8')).not.toContain('resolved nm-');
  });

  it.each([
    { itemId: 'nm-000000000000', reply: 'x', extra: 1 },
    { itemId: 'nm-000000000000', reply: 'x', runsDir: '/tmp/fake' },
    { reply: 'x' },
    { itemId: 'bogus' },
    { itemId: 'NM-000000000000' },
    { itemId: 'nm-000000000000', reply: 42 },
    { itemId: 'nm-000000000000', reply: 'x'.repeat(501) },
  ])('rejects %j before any mutation', async args => {
    const { result, text } = await call(RESOLVE, args);
    expect(result.isError).toBe(true);
    expect(text).toContain('invalid needs resolve arguments');
    expect(busBodies()).toEqual([]);
    expect(existsSync(inboxPath())).toBe(false);
    expect(readFileSync(needsPath(), 'utf8')).not.toContain('resolved nm-');
  });

  it.each([null, [], 'nm-000000000000'])('rejects non-object input %j', async args => {
    const { result, text } = await call(RESOLVE, args);
    expect(result.isError).toBe(true);
    expect(text).toContain('invalid needs resolve arguments');
    expect(busBodies()).toEqual([]);
  });

  it('accepts a reply at the existing limit and rejects one character over', async () => {
    const [item] = await listedItems();
    const over = await call(RESOLVE, { itemId: item!.id, reply: 'x'.repeat(501) });
    expect(over.result.isError).toBe(true);
    expect(over.text).toContain('invalid needs resolve arguments');
    expect(busBodies()).toEqual([]);
    const within = await call(RESOLVE, { itemId: item!.id, reply: 'x'.repeat(500) });
    expect(within.result.isError).toBeFalsy();
    expect(busBodies()).toHaveLength(1);
  });

  it('reports inbox failure honestly: the resolution lands but planner delivery is not claimed', async () => {
    // Force a real append failure: `leader` exists as a file, so MASON-INBOX.md
    // cannot be created under it. No mocking of the relay result.
    writeFileSync(join(runs, 'leader'), 'not a directory');
    const [item] = await listedItems();
    const { result, text } = await call(RESOLVE, { itemId: item!.id, reply: 'fake explicit answer' });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'resolved', itemId: item!.id, inbox: 'failed' });
    expect(text).not.toContain('appended');
    expect(busBodies()).toHaveLength(1);
    expect(readFileSync(needsPath(), 'utf8')).toContain(`- [x] resolved ${item!.id}`);
  });

  it('stays refused under the kill switch like every append tool', async () => {
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    writeFileSync(join(home, '.ashlr', 'KILL'), 'kill switch active\n');
    const [item] = await listedItems();
    const { result, text } = await call(RESOLVE, { itemId: item!.id, reply: 'fake answer' });
    expect(result.isError).toBe(true);
    expect(text).toContain('kill switch');
    expect(busBodies()).toEqual([]);
    expect(readFileSync(needsPath(), 'utf8')).not.toContain('resolved nm-');
  });
});
