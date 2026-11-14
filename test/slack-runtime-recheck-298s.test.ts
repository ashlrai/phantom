/**
 * RQ-PHX-DOTTAILSCALERECHECK298S — bounded recheck evidence for the existing
 * Slack bridge owner after the Nov 13 Tailscale change. Proves through the real
 * buildSlackBridgeStatus that a fully configured OFFLINE bridge plus recent
 * journal evidence can never establish live transport or assignment:
 * transport.health stays 'unknown' and observedAt stays null however ready
 * the configuration reads, because only an authenticated probe/run observes
 * transport. Missing or unreadable local evidence is reported honestly through
 * the supported config/slackSection/journal/comms fields — nothing upgrades it.
 * Fake ids only; temp roots; no credentials, no network, no real host data.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSlackBridgeStatus } from '../src/core/agents/slack-status.js';
import { recordSlackObservation, slackJournalPath } from '../src/core/agents/slack-journal.js';

const NOW = () => new Date('2026-11-13T18:30:00.000Z');

const TOML = `[team]
identities = [
  { channel = "slack", id = "U0RECHECKHUMAN" },
  { channel = "slack", id = "B0RECHECKAGENT" },
]

[slack]
team_id = "T0RECHECKTEAM"
own_user_id = "U0RECHECKBOT"
own_bot_id = "B0RECHECKBOT"
bot_token_ref = "phm_SLACK_AGENTNET_BOT_TOKEN"
app_token_ref = "phm_SLACK_AGENTNET_APP_TOKEN"

[[slack.map]]
topic = "leaders"
channel = "C0RECHECKNET"
`;

let root: string;
let ashlarDir: string;
let runsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slack-recheck-298s-'));
  ashlarDir = join(root, 'ashlr'); // stands in for ~/.ashlr
  mkdirSync(ashlarDir, { mode: 0o700 });
  runsDir = join(root, 'runs');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function writeConfig(text: string | null, comms: string | null = 'confirmedByMason = true\n'): void {
  if (text !== null) writeFileSync(join(ashlarDir, 'agent-network.toml'), text, { mode: 0o600 });
  if (comms !== null) writeFileSync(join(ashlarDir, 'comms.toml'), comms, { mode: 0o600 });
}

const report = () => buildSlackBridgeStatus({ home: ashlarDir, runsDir, now: NOW });

describe('slack runtime recheck 298s', () => {
  it('a ready offline bridge with fresh journal evidence still reports unknown transport', () => {
    writeConfig(TOML);
    // Recent ingested deliveries incl. bus 'posted' — the strongest journal can get.
    for (const [i, at] of ['2026-11-13T17:50:00.000Z', '2026-11-13T18:10:00.000Z', '2026-11-13T18:25:00.000Z'].entries()) {
      recordSlackObservation({ at, decision: 'ingested', bus: 'posted', channelId: 'C0RECHECKNET', authorId: 'U0RECHECKHUMAN', envelopeId: `env-${i}` }, { runsDir });
    }
    recordSlackObservation({ at: '2026-11-13T18:28:00.000Z', decision: 'ignored', reason: 'untrusted-sender', channelId: 'C0RECHECKNET' }, { runsDir });

    const s = report();
    expect(s.at).toBe('2026-11-13T18:30:00.000Z');
    expect(s.config).toEqual({ path: join(ashlarDir, 'agent-network.toml'), state: 'ok' });
    expect(s.slackSection).toBe('ok');
    expect(s.bridge).toEqual({ id: 'slack', teamId: 'T0RECHECKTEAM', ownUserId: 'U0RECHECKBOT', ownBotId: 'B0RECHECKBOT' });
    expect(s.credentials).toEqual({ custody: 'phantom-secrets', botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN', appTokenRef: 'phm_SLACK_AGENTNET_APP_TOKEN' });
    expect(s.mappings).toEqual([{ topic: 'leaders', channel: 'C0RECHECKNET' }]);
    expect(s.teamIdentities).toEqual({ slack: 2, total: 2 });
    expect(s.comms.confirmedByMason).toBe(true);
    expect(s.journal).toEqual({ state: 'ok', ingested: 3, ignored: 1, lastAt: '2026-11-13T18:28:00.000Z', ignoredReasons: [{ reason: 'untrusted-sender', count: 1, lastAt: '2026-11-13T18:28:00.000Z' }], ignoredReasonsOmitted: 0 });
    expect(s.ready).toBe(true);

    // `at` is when this offline report was generated; transport.observedAt is
    // null because nothing authenticated was observed — journal posts are not it.
    expect(s.transport).toEqual({ health: 'unknown', observedAt: null, probeCommand: 'phm channels slack probe --json' });
    expect(Object.keys(s.transport).sort()).toEqual(['health', 'observedAt', 'probeCommand']);
    expect(s).not.toHaveProperty('assignment');
    expect(s).not.toHaveProperty('connected');
    expect(s.next).toContain('phm channels slack probe --json');
    // Credentials surface as phm_ reference names only — never token values.
    expect(JSON.stringify(s)).not.toMatch(/xox[bap]-/);

    // A later report timestamp moves `at` only; the transport block cannot improve.
    const later = buildSlackBridgeStatus({ home: ashlarDir, runsDir, now: () => new Date('2026-11-13T19:00:00.000Z') });
    expect(later.at).toBe('2026-11-13T19:00:00.000Z');
    expect(later.transport).toEqual(s.transport);
    expect(later.ready).toBe(true);
  });

  it('missing config, comms and journal are reported as missing, never upgraded', () => {
    const s = report();
    expect(s.at).toBe('2026-11-13T18:30:00.000Z');
    expect(s.config).toEqual({ path: join(ashlarDir, 'agent-network.toml'), state: 'missing' });
    expect(s.slackSection).toBe('absent');
    expect(s.bridge).toBeNull();
    expect(s.credentials).toEqual({ custody: 'phantom-secrets', botTokenRef: null, appTokenRef: null });
    expect(s.mappings).toEqual([]);
    expect(s.teamIdentities).toEqual({ slack: 0, total: 0 });
    expect(s.comms.confirmedByMason).toBe(false);
    expect(s.journal).toEqual({ state: 'missing', ingested: 0, ignored: 0, lastAt: null, ignoredReasons: [], ignoredReasonsOmitted: 0 });
    expect(s.ready).toBe(false);
    expect(s.transport).toEqual({ health: 'unknown', observedAt: null, probeCommand: 'phm channels slack probe --json' });
    expect(s.next).toContain('agent-network.toml');
  });

  it('a malformed [slack] section fails closed while the file itself stays ok', () => {
    writeConfig(TOML.replace('T0RECHECKTEAM', 'not a team id'));
    const s = report();
    expect(s.config.state).toBe('ok');
    expect(s.slackSection).toBe('invalid');
    expect(s.bridge).toBeNull();
    expect(s.mappings).toEqual([]);
    expect(s.teamIdentities).toEqual({ slack: 2, total: 2 });
    expect(s.ready).toBe(false);
    expect(s.transport.health).toBe('unknown');
    expect(s.transport.observedAt).toBeNull();
    expect(s.next).toContain('[slack]');
  });

  it('a degraded journal is surfaced honestly and still proves no connectivity', () => {
    writeConfig(TOML);
    mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
    writeFileSync(slackJournalPath(runsDir),
      'this is not json\n{"at":"2026-11-13T18:10:00.000Z","decision":"ingested","bus":"posted"}\n',
      { mode: 0o600 });
    const s = report();
    expect(s.journal).toEqual({ state: 'degraded', ingested: 1, ignored: 0, lastAt: '2026-11-13T18:10:00.000Z', ignoredReasons: [], ignoredReasonsOmitted: 0 });
    expect(s.ready).toBe(true);
    expect(s.transport).toEqual({ health: 'unknown', observedAt: null, probeCommand: 'phm channels slack probe --json' });
  });
});
