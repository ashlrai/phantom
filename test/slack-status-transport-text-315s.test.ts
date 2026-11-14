/**
 * RQ-PHX-SLACKTRANSPORTTEXT315S: the text form of `phm channels slack status`
 * must report the transport triple honestly alongside configuration readiness.
 * buildSlackBridgeStatus already returns transport.health='unknown',
 * observedAt=null and probeCommand='phm channels slack probe --json' because
 * status is offline; printStatus previously omitted the object entirely, so a
 * ready=true configuration could read as live transport evidence. This suite
 * drives the real cmdChannelsSlack with a synthetic status and proves:
 *   - text output prints transport health unknown, observation unknown and
 *     the existing probe command, for both ready and unconfigured reports;
 *   - --json output preserves the structured transport fields unchanged;
 *   - the status path never reaches the probe/run transport seam.
 * Fake ids only; no credentials, sockets, network or real host data.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdChannelsSlack } from '../src/cli/channels-slack.js';
import { buildSlackBridgeStatus, type SlackBridgeStatus } from '../src/core/agents/slack-status.js';
import {
  createSlackApi, deliverSlackEnvelope, openSlackSocket, verifySlackIdentity,
} from '../src/core/agents/slack-transport.js';

vi.mock('../src/core/agents/slack-status.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/agents/slack-status.js')>();
  return { ...actual, buildSlackBridgeStatus: vi.fn() };
});

vi.mock('../src/core/agents/slack-transport.js', () => ({
  createSlackApi: vi.fn(),
  deliverSlackEnvelope: vi.fn(),
  openSlackSocket: vi.fn(),
  verifySlackIdentity: vi.fn(),
}));

const PROBE = 'phm channels slack probe --json';

function statusFixture(overrides: Partial<SlackBridgeStatus> = {}): SlackBridgeStatus {
  return {
    v: 1,
    at: '2026-11-13T18:30:00.000Z',
    config: { path: '/fake-home/.ashlr/agent-network.toml', state: 'ok' },
    slackSection: 'ok',
    bridge: { id: 'slack', teamId: 'T0FAKETEAM', ownUserId: 'U0FAKEBOT', ownBotId: 'B0FAKEBOT' },
    credentials: { custody: 'phantom-secrets', botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN', appTokenRef: 'phm_SLACK_AGENTNET_APP_TOKEN' },
    mappings: [{ topic: 'leaders', channel: 'C0FAKECHANNEL' }],
    teamIdentities: { slack: 2, total: 2 },
    comms: { confirmedByMason: true },
    journal: { state: 'ok', ingested: 3, ignored: 1, lastAt: '2026-11-13T18:28:00.000Z' },
    replies: { state: 'ok', answered: 3, unanswered: 0, oldestUnansweredAt: null, uncertainSends: 0, rejected: 0, futureDated: 0, unansweredSample: [] },
    ready: true,
    transport: { health: 'unknown', observedAt: null, probeCommand: PROBE },
    next: `mapping is ready; run ${PROBE} for authenticated identity`,
    ...overrides,
  };
}

const missingConfig = (): SlackBridgeStatus => statusFixture({
  config: { path: '/fake-home/.ashlr/agent-network.toml', state: 'missing' },
  slackSection: 'absent',
  bridge: null,
  credentials: { custody: 'phantom-secrets', botTokenRef: null, appTokenRef: null },
  mappings: [],
  teamIdentities: { slack: 0, total: 0 },
  comms: { confirmedByMason: false },
  journal: { state: 'missing', ingested: 0, ignored: 0, lastAt: null },
  replies: { state: 'missing', answered: 0, unanswered: 0, oldestUnansweredAt: null, uncertainSends: 0, rejected: 0, futureDated: 0, unansweredSample: [] },
  ready: false,
  next: 'create ~/.ashlr/agent-network.toml -- see docs/AGENT-NETWORK.md (Slack bridge)',
});

async function runStatus(args: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(' '));
  });
  try {
    const code = await cmdChannelsSlack(['status', ...args]);
    return { code, lines };
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  vi.mocked(buildSlackBridgeStatus).mockReset();
  vi.clearAllMocks();
});

describe('channels slack status text transport reporting (315s)', () => {
  it('prints the unknown transport triple next to ready=yes for a configured bridge', async () => {
    vi.mocked(buildSlackBridgeStatus).mockReturnValue(statusFixture());
    const { code, lines } = await runStatus([]);
    expect(code).toBe(0);
    expect(lines).toContain('ready: yes');
    expect(lines).toContain(`transport: health=unknown observedAt=unknown probe=${PROBE}`);
    // Readiness never upgrades into a connectivity claim.
    expect(lines.join('\n')).not.toMatch(/transport: health=(up|ok|healthy|connected)/);
  });

  it('keeps transport unknown when the config is missing', async () => {
    vi.mocked(buildSlackBridgeStatus).mockReturnValue(missingConfig());
    const { code, lines } = await runStatus([]);
    expect(code).toBe(0);
    expect(lines).toContain('ready: no');
    expect(lines).toContain(`transport: health=unknown observedAt=unknown probe=${PROBE}`);
  });

  it('preserves the structured transport fields in --json output', async () => {
    const fixture = statusFixture();
    vi.mocked(buildSlackBridgeStatus).mockReturnValue(fixture);
    const { code, lines } = await runStatus(['--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as SlackBridgeStatus;
    expect(parsed.transport).toEqual({ health: 'unknown', observedAt: null, probeCommand: PROBE });
    expect(parsed.ready).toBe(true);
    // JSON stays the structured status: no flattened transport text line.
    expect(lines.some(line => line.startsWith('transport:'))).toBe(false);
  });

  it('never reaches the probe/run transport seam from status', async () => {
    vi.mocked(buildSlackBridgeStatus).mockReturnValue(statusFixture());
    await runStatus([]);
    await runStatus(['--json']);
    expect(verifySlackIdentity).not.toHaveBeenCalled();
    expect(createSlackApi).not.toHaveBeenCalled();
    expect(openSlackSocket).not.toHaveBeenCalled();
    expect(deliverSlackEnvelope).not.toHaveBeenCalled();
  });
});
