import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { cmdChannelsSlack } from '../src/cli/channels-slack.js';
import { cmdFleetSlackTrace } from '../src/cli/fleet-slack-trace.js';

let root: string;
let home: string;
let lines: string[];
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slack-cli-450s-'));
  home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_HOME', home);
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'runs'));
  lines = [];
  vi.spyOn(console, 'log').mockImplementation(value => { lines.push(String(value)); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  network = vi.fn(() => { throw new Error('network forbidden'); });
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('WebSocket', network);
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function configure(): void {
  writeFileSync(join(home, 'agent-network.toml'), `[team]
identities = [{ channel = "slack", id = "U0FAKEHUMAN" }]
[slack]
team_id = "T0FAKETEAM"
bot_token_ref = "phm_SLACK_AGENTNET_BOT_TOKEN"
app_token_ref = "phm_SLACK_AGENTNET_APP_TOKEN"
[[slack.map]]
topic = "leaders"
channel = "C0FAKECHANNEL"
`, { mode: 0o600 });
}

function contents(dir = root): Record<string, string> {
  return Object.assign({}, ...readdirSync(dir, { withFileTypes: true }).map(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? contents(path) : { [relative(root, path)]: readFileSync(path, 'utf8') };
  }));
}

it('preserves original status JSON while missing state and transport remain unknown', async () => {
  const before = contents();
  expect(await cmdChannelsSlack(['status', '--json'])).toBe(0);
  expect(JSON.parse(lines.pop()!)).toMatchObject({
    config: { state: 'missing' }, ready: false, journal: { state: 'missing' },
    replies: { state: 'missing' }, transport: { health: 'unknown', observedAt: null },
  });
  expect(await cmdChannelsSlack(['probe', '--json'])).toBe(1);
  expect(JSON.parse(lines.pop()!)).toMatchObject({ ok: false, reason: 'slack-not-configured' });
  expect(contents()).toEqual(before);
});

it('preserves original map/topic semantics and distinguishes config readiness from runtime proof', async () => {
  configure();
  const before = contents();
  expect(await cmdChannelsSlack(['status', '--json'])).toBe(0);
  expect(JSON.parse(lines.pop()!)).toMatchObject({ ready: true, transport: { health: 'unknown', observedAt: null } });
  expect(await cmdChannelsSlack(['map', '--topic', 'leaders', '--json'])).toBe(0);
  expect(JSON.parse(lines.pop()!)).toMatchObject({ dryRun: true, route: { topic: 'leaders', ok: true, channel: 'C0FAKECHANNEL' } });
  expect(await cmdChannelsSlack(['map', '--topic', 'unmapped', '--json'])).toBe(0);
  expect(JSON.parse(lines.pop()!)).toMatchObject({ route: { ok: false, reason: 'unmapped-topic' } });
  expect(contents()).toEqual(before);
});

it('keeps missing trace evidence unsuccessful through the real JSON command', async () => {
  const before = contents();
  expect(await cmdFleetSlackTrace(['--json'], { runsDir: join(root, 'runs'), stateRoot: join(root, 'state') })).toBe(1);
  expect(JSON.parse(lines.pop()!)).toMatchObject({ sources: { journal: 'missing', sends: 'missing' }, rows: [] });
  expect(contents()).toEqual(before);
});

it.each([
  ['status', '--apply'], ['map', '--snapshot'], ['map', '--topic', ''],
  ['probe', '--seconds', '1'], ['run', '--seconds', '0'], ['run', '--seconds', '301'],
  ['run', '--seconds', '1', '--apply'],
])('rejects invalid %j arguments before writes or network', async (...args) => {
  configure();
  const before = contents();
  expect(await cmdChannelsSlack(args)).toBe(2);
  expect(lines).toEqual([]);
  expect(contents()).toEqual(before);
});
