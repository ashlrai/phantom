/**
 * RQ-PHX-SLACKOFFLINEEVIDENCE279S -- CLI-level offline-evidence proof for the
 * Slack bridge diagnostics (Mason/Dot Nov 12 22:29-22:30 request: a safe
 * read-only status test). Drives the real cmdChannelsSlack status/map
 * entrypoints against an isolated HOME/ASHLR_HOME/ASHLR_RUNS_DIR fixture.
 * Every Slack transport client is mocked to count-and-throw and fetch is
 * stubbed -- synthetic ids only, no socket, no Slack API, no credential
 * lookup, no bus append, no outbound message. Proves the diagnostics report
 * offline state honestly; does not exercise or claim the probe/run lane.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { cmdChannelsSlack } from '../src/cli/channels-slack.js';
import type { SlackBridgeStatus, SlackMapReport } from '../src/core/agents/slack-status.js';

// The established module-mock pattern: the real module stays, but the
// transport entry points become spies that record and throw if a read-only
// diagnostic ever reaches them.
const transportSpies = vi.hoisted(() => ({
  createSlackApi: vi.fn(() => { throw new Error('offline diagnostic opened a Slack API client'); }),
  deliverSlackEnvelope: vi.fn(() => { throw new Error('offline diagnostic delivered a Slack envelope'); }),
  openSlackSocket: vi.fn(() => { throw new Error('offline diagnostic opened a Slack socket'); }),
  verifySlackIdentity: vi.fn(() => { throw new Error('offline diagnostic verified Slack identity'); }),
}));
vi.mock('../src/core/agents/slack-transport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/agents/slack-transport.js')>()),
  ...transportSpies,
}));

const VALID_TOML = `[team]
identities=[{channel="slack",id="U0FAKEHUMAN"},{channel="slack",id="B0FAKEAGENT"}]
[slack]
team_id="T0FAKEWS"
own_user_id="U0FAKEBOT"
own_bot_id="B0FAKEBOT"
bot_token_ref="phm_SLACK_FAKE_BOT_TOKEN"
app_token_ref="phm_SLACK_FAKE_APP_TOKEN"
[[slack.map]]
topic="leaders"
channel="C0FAKECHAN"
`;
const JOURNAL = `{"at":"2026-11-12T22:29:00.000Z","decision":"ingested","bus":"posted","channelId":"C0FAKECHAN","authorId":"U0FAKEHUMAN"}
{"at":"2026-11-12T22:30:00.000Z","decision":"ignored","reason":"unmapped-channel","channelId":"C0FAKECHAN"}
`;

const savedEnv = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
const roots: string[] = [];
let home: string;
let out: string[];
let errOut: string[];
let logSpy: MockInstance<typeof console.log>;
let errSpy: MockInstance<typeof console.error>;
let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'slack-offline-279s-'));
  roots.push(home);
  process.env.HOME = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
  process.env.ASHLR_RUNS_DIR = join(home, '.ashlr-runs');
  out = [];
  errOut = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { out.push(values.map(String).join(' ')); });
  errSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => { errOut.push(values.map(String).join(' ')); });
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline diagnostic fetched'));
  for (const spy of Object.values(transportSpies)) spy.mockClear();
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  fetchSpy.mockRestore();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Write agent-network.toml (when non-null), comms.toml and an optional journal fixture. */
function seed(toml: string | null, journal?: string): void {
  const ashlr = process.env.ASHLR_HOME!;
  mkdirSync(ashlr, { recursive: true, mode: 0o700 });
  if (toml !== null) writeFileSync(join(ashlr, 'agent-network.toml'), toml, { mode: 0o600 });
  writeFileSync(join(ashlr, 'comms.toml'), 'confirmedByMason = true\n', { mode: 0o600 });
  if (journal !== undefined) {
    const dir = join(process.env.ASHLR_RUNS_DIR!, 'slack-bridge');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'journal.jsonl'), journal, { mode: 0o600 });
  }
}

async function runJson<T>(args: string[]): Promise<T> {
  out.length = 0;
  expect(await cmdChannelsSlack(args)).toBe(0);
  expect(out).toHaveLength(1);
  return JSON.parse(out[0]!) as T;
}

function treeSnapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const path of readdirSync(root, { recursive: true })) {
    const full = join(root, path);
    if (statSync(full).isFile()) files[path] = createHash('sha256').update(readFileSync(full)).digest('hex');
  }
  return files;
}

function expectNoTransport(): void {
  for (const spy of Object.values(transportSpies)) expect(spy).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
}

describe('channels slack status --json offline evidence', () => {
  it('reports missing and invalid config accurately without claiming readiness', async () => {
    seed(null);
    const missing = await runJson<SlackBridgeStatus>(['status', '--json']);
    expect(missing.config).toEqual({ path: join(process.env.ASHLR_HOME!, 'agent-network.toml'), state: 'missing' });
    expect(missing).toMatchObject({ slackSection: 'absent', bridge: null, mappings: [], ready: false, journal: { state: 'missing' } });
    expect(missing.comms.confirmedByMason).toBe(true);
    expect(missing.next).toContain('agent-network.toml');
    expect(missing.transport).toEqual({ health: 'unknown', observedAt: null, probeCommand: 'phm channels slack probe --json' });

    seed('this = [is not toml');
    const broken = await runJson<SlackBridgeStatus>(['status', '--json']);
    expect(broken.config.state).toBe('invalid');
    expect(broken.slackSection).toBe('absent');
    expect(broken.ready).toBe(false);
    expect(broken.next).toContain('does not parse');

    seed('[slack]\nteam_id = "not-a-team-id"\n');
    const invalidSlack = await runJson<SlackBridgeStatus>(['status', '--json']);
    expect(invalidSlack).toMatchObject({ config: { state: 'ok' }, slackSection: 'invalid', bridge: null, ready: false });
    expect(invalidSlack.next).toContain('[slack]');
  });

  it('reports a configured offline bridge as ready with unknown transport, never connected', async () => {
    seed(VALID_TOML, JOURNAL);
    const status = await runJson<SlackBridgeStatus>(['status', '--json']);
    expect(status).toMatchObject({
      config: { state: 'ok' }, slackSection: 'ok', ready: true,
      bridge: { id: 'slack', teamId: 'T0FAKEWS', ownUserId: 'U0FAKEBOT', ownBotId: 'B0FAKEBOT' },
      credentials: { custody: 'phantom-secrets', botTokenRef: 'phm_SLACK_FAKE_BOT_TOKEN', appTokenRef: 'phm_SLACK_FAKE_APP_TOKEN' },
      mappings: [{ topic: 'leaders', channel: 'C0FAKECHAN' }],
      teamIdentities: { slack: 2, total: 2 }, comms: { confirmedByMason: true },
      journal: { state: 'ok', ingested: 1, ignored: 1, lastAt: '2026-11-12T22:30:00.000Z' },
    });
    // As-of evidence: snapshot time plus last journaled observation; this
    // command never observes the transport and names probe/run as the separate
    // authenticated host operations that would.
    expect(status.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(status.transport).toEqual({ health: 'unknown', observedAt: null, probeCommand: 'phm channels slack probe --json' });
    expect(status.next).toContain('phm channels slack probe');
    // The offline report carries no connection, worker, assignment or claim fields.
    expect(Object.keys(status).sort()).toEqual(
      ['at', 'bridge', 'comms', 'config', 'credentials', 'journal', 'mappings', 'next', 'ready', 'slackSection', 'teamIdentities', 'transport', 'v'].sort());
    expect(JSON.stringify(status)).not.toMatch(/"?(connected|assigned|claimed|worker|socket)"?\s*:/i);
  });
});

describe('channels slack map --json offline evidence', () => {
  it('is a read-only dry run that agrees with the configured topic/channel mapping', async () => {
    seed(VALID_TOML);
    const report = await runJson<SlackMapReport>(['map', '--json']);
    expect(report).toMatchObject({
      v: 1, dryRun: true, config: { state: 'ok' },
      bridge: { id: 'slack', teamId: 'T0FAKEWS' },
      mappings: [{ topic: 'leaders', channel: 'C0FAKECHAN', threadRefExample: 'slack:T0FAKEWS:C0FAKECHAN:<root_ts>' }],
      comms: { confirmedByMason: true },
    });
    expect(report.audienceGates.length).toBeGreaterThan(0);
    expect(report.note).toContain('dry run only');
    expect(report).not.toHaveProperty('route');
    expect((await runJson<SlackMapReport>(['map', '--topic', 'leaders', '--json'])).route)
      .toEqual({ topic: 'leaders', ok: true, channel: 'C0FAKECHAN' });
    expect((await runJson<SlackMapReport>(['map', '--topic', 'nowhere', '--json'])).route)
      .toEqual({ topic: 'nowhere', ok: false, reason: 'unmapped-topic' });
    expectNoTransport();
  });
});

describe('channels slack offline side effects', () => {
  it('repeated status and map runs leave every fixture file byte-identical and create nothing', async () => {
    seed(VALID_TOML, JOURNAL);
    const before = treeSnapshot(home);
    for (let i = 0; i < 3; i++) {
      await runJson<SlackBridgeStatus>(['status', '--json']);
      await runJson<SlackMapReport>(['map', '--json']);
      await runJson<SlackMapReport>(['map', '--topic', 'leaders', '--json']);
    }
    expect(treeSnapshot(home)).toEqual(before);
    expect(Object.keys(before).sort()).toEqual([
      join('.ashlr', 'agent-network.toml'), join('.ashlr', 'comms.toml'), join('.ashlr-runs', 'slack-bridge', 'journal.jsonl'),
    ].sort());
    expect(Object.keys(before).join('\n')).not.toMatch(/inbox|outbox|claim|dispatch/i);
    expectNoTransport();
  });

  it('rejects execution and unknown flags on the read-only diagnostics', async () => {
    seed(VALID_TOML);
    const before = treeSnapshot(home);
    for (const args of [
      ['status', '--apply'], ['status', '--seconds', '5'], ['status', '--snapshot', 'x'],
      ['map', '--seconds', '30'], ['map', '--apply'], ['map', '--topic'],
    ]) {
      out.length = 0;
      errOut.length = 0;
      expect(await cmdChannelsSlack(args), args.join(' ')).toBe(2);
      expect(errOut.join('\n'), args.join(' ')).toContain('usage: phm channels slack status');
    }
    expect(treeSnapshot(home)).toEqual(before);
    expectNoTransport();
  });
});
