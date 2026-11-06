import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmdFleetTelegramPulse } from '../src/cli/fleet-telegram-pulse.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { VisibilitySnapshot } from '../src/core/web/visibility.js';

const snap = {
  generatedAt: '2026-11-03T12:00:00Z',
  director: { topGoalObjective: 'Check <fleet> & "status"', escalationCount: 0, resourcePosture: 'full' },
  fleetActivity: { totalDispatches: 0, mergedToday: 0, rejectedToday: 0, proposalsPending: 0 },
  resourceGrid: [], costSavings: { todaySpendUsd: 0 },
} as VisibilitySnapshot;
const cfg = { comms: { proactive: true, enabled: true, channel: 'telegram',
  telegram: { botToken: 'fake-token', chatId: 'fake-chat' } } } as AshlrConfig;

async function run(args: string[], config = cfg, fail = false) {
  const logs: string[] = [], errors: string[] = [], sends: string[] = [];
  const originalLog = console.log, originalError = console.error;
  console.log = (text: string) => { logs.push(text); };
  console.error = (text: string) => { errors.push(text); };
  try {
    const code = await cmdFleetTelegramPulse(args, {
      loadConfig: () => config,
      buildSnapshot: async () => { if (fail) throw new Error('fake-token fake-chat'); return snap; },
      send: async (text, received) => { assert.equal(received, config); sends.push(text); },
    });
    return { code, logs, errors, sends };
  } finally { console.log = originalLog; console.error = originalError; }
}

test('dry run prints decoded plain text and sends nothing', async () => {
  const result = await run([]);
  assert.equal(result.code, 0);
  assert.match(result.logs[0]!, /Phantom fleet/);
  assert.doesNotMatch(result.logs[0]!, /<b>/);
  assert.match(result.logs[0]!, /Check <fleet> & "status"/);
  assert.equal(result.sends.length, 0);
  assert.equal(JSON.parse((await run(['--json'])).logs[0]!).mode, 'dry-run');
});

test('send reports proactive-off without calling sender', async () => {
  const result = await run(['--send', '--json'], { ...cfg, comms: { ...cfg.comms, proactive: false } } as AshlrConfig);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.logs[0]!).reason, 'proactive-off');
  assert.equal(JSON.parse(result.logs[0]!).sent, false);
  assert.equal(result.sends.length, 0);
});

test('send reports telegram-off without calling sender', async () => {
  const result = await run(['--send', '--json'], { ...cfg, comms: { ...cfg.comms, enabled: false } } as AshlrConfig);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.logs[0]!).reason, 'telegram-off');
  assert.equal(JSON.parse(result.logs[0]!).sent, false);
  assert.equal(result.sends.length, 0);
});

test('enabled send passes HTML once', async () => {
  const result = await run(['--send', '--json']);
  assert.equal(result.code, 0);
  assert.equal(result.sends.length, 1);
  assert.match(result.sends[0]!, /<b>Phantom fleet<\/b>/);
  assert.equal(JSON.parse(result.logs[0]!).sent, true);
  assert.equal(JSON.parse(result.logs[0]!).mode, 'send');
});

test('snapshot failures hide details', async () => {
  const result = await run(['--send'], cfg, true);
  assert.equal(result.code, 1);
  assert.deepEqual(result.errors, ['Unable to build fleet pulse.']);
  assert.deepEqual(result.logs, []);
  assert.deepEqual(result.sends, []);
});

test('exact flags and help', async () => {
  for (const args of [['--unknown'], ['--json', '--json'], ['--send', '--send'], ['--help', '--json']]) {
    const result = await run(args);
    assert.equal(result.code, 2);
    assert.match(result.errors[0]!, /^Usage:/);
  }
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.logs[0]!, /^Usage:/);
});

test('registry loads telegram-pulse', async () => {
  assert.equal((await FLEET_SUBCOMMAND_LOADERS['telegram-pulse']!()).cmdFleetTelegramPulse, cmdFleetTelegramPulse);
});
