import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { parseInbox } from '../src/core/fleet/mason-inbox.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
let scratch = '';
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

function stage(needsBody: string) {
  scratch = mkdtempSync(join(tmpdir(), 'mcp-provenance-'));
  const runs = join(scratch, 'runs');
  const ashlrHome = join(scratch, 'ashlr');
  vi.stubEnv('HOME', scratch);
  vi.stubEnv('ASHLR_HOME', ashlrHome);
  vi.stubEnv('ASHLR_RUNS_DIR', runs);
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, 'NEEDS-MASON.md'), needsBody);
  return { runs, ashlrHome };
}

const busBodies = (ashlrHome: string): Record<string, unknown>[] => {
  const page = listBusInboxAfter(0, 100, { root: join(ashlrHome, 'fleet') });
  return page.status === 'ok' ? page.messages.map(message => message.envelope.body as Record<string, unknown>) : [];
};

it('persists an unverified agent reply once through the MCP tool', async () => {
  const { runs, ashlrHome } = stage('- [ ] Pick a fictional colour\n');
  const listed = await callNativeTool('phantom_fleet_needs', {});
  const { items } = JSON.parse(listed.content[0]!.text) as { items: { id: string }[] };
  const itemId = items[0]!.id;
  const reply = 'Choose imaginary blue';
  const first = await callNativeTool('phantom_fleet_needs_resolve', { itemId, reply });
  expect(first.isError).toBeFalsy();
  expect(JSON.parse(first.content[0]!.text)).toMatchObject({ v: 1, status: 'resolved', itemId, duplicate: false, inbox: 'appended' });
  const again = await callNativeTool('phantom_fleet_needs_resolve', { itemId, reply });
  expect(again.isError).toBe(true);
  expect(JSON.parse(again.content[0]!.text)).toMatchObject({ status: 'already-resolved', itemId, inbox: 'skipped' });
  // The durable bus resolution is attributed to the agent surface, not Mason's CLI.
  expect(busBodies(ashlrHome)).toEqual([
    expect.objectContaining({ kind: 'needs_mason.resolved', itemId, source: 'leader', reply }),
  ]);
  // The planner inbox entry is labeled as an unverified agent relay.
  const inbox = parseInbox(readFileSync(join(runs, 'leader', 'MASON-INBOX.md'), 'utf8'));
  expect(inbox).toHaveLength(1);
  expect(inbox[0]).toMatchObject({ channel: 'agent-via-mcp-unverified', text: `Re needs-you ${itemId} ("Pick a fictional colour"): ${reply}` });
  expect(readFileSync(join(runs, 'NEEDS-MASON.md'), 'utf8')).toContain(`- [x] resolved ${itemId}`);
});

it('retains the ordinary CLI source on both the bus and inbox', async () => {
  const { runs, ashlrHome } = stage('- [ ] Choose a fictional animal\n');
  const listed = await callNativeTool('phantom_fleet_needs', {});
  const { items } = JSON.parse(listed.content[0]!.text) as { items: { id: string }[] };
  const { cmdFleetNeedsResolve } = await import('../src/cli/fleet-needs-resolve.js');
  expect(await cmdFleetNeedsResolve([items[0]!.id, '--runs-dir', runs, '--reply', 'A fictional fox'])).toBe(0);
  const bus = listBusInboxAfter(0, 100, { root: join(ashlrHome, 'fleet') });
  expect(bus.status).toBe('ok');
  if (bus.status !== 'ok') throw new Error('bus unavailable');
  expect(bus.messages).toHaveLength(1);
  expect(bus.messages[0]!.envelope.body).toMatchObject({ kind: 'needs_mason.resolved', source: 'cli' });
  expect(parseInbox(readFileSync(join(runs, 'leader', 'MASON-INBOX.md'), 'utf8'))).toMatchObject([{ channel: 'cli' }]);
});

it('keeps phantom_fleet_needs_wait registered and validating its arguments', async () => {
  expect(nativeToolSafety('phantom_fleet_needs_wait')).toBe('read');
  expect(listNativeTools().some(tool => tool.name === 'phantom_fleet_needs_wait')).toBe(true);
  const bad = await callNativeTool('phantom_fleet_needs_wait', { itemId: 'nm-000000000000', timeoutMs: 0 });
  expect(bad.isError).toBe(true);
  expect(bad.content[0]!.text).toContain('invalid fleet needs wait arguments');
  stage('- [ ] A fictional wait item\n');
  const good = await callNativeTool('phantom_fleet_needs_wait', { itemId: 'nm-000000000000', timeoutMs: 1, pollMs: 100 });
  expect(good.isError).toBeFalsy();
  const body = JSON.parse(good.content[0]!.text) as { itemId: string; status: string };
  expect(body).toMatchObject({ itemId: 'nm-000000000000' });
  expect(['resolved', 'timeout', 'unknown', 'unavailable', 'cancelled']).toContain(body.status);
});
