import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultChannelSources, readChannelHealth, type ChannelSource } from '../src/core/fleet/channel-health.js';

const slackConfig = `[slack]
team_id="T0FAKETEAM"
bot_token_ref="phm_FAKE_BOT"
app_token_ref="phm_FAKE_APP"
[[slack.map]]
topic="fake-topic"
channel="C0FAKECHANNEL"
`;
const other: ChannelSource = { configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [] };

describe('Slack channel health identity prerequisite', () => {
  it.each([
    ['no identities', '', false],
    ['iMessage identity only', '[team]\nidentities=[{channel="imessage",id="fake-imessage-identity"}]\n', false],
    ['Slack identity', '[team]\nidentities=[{channel="slack",id="U0FAKEIDENTITY"}]\n', true],
  ])('%s', async (_name, identities, configured) => {
    const home = mkdtempSync(join(tmpdir(), 'slack-identity-947s-'));
    const savedHome = process.env['HOME'];
    const savedAshlr = process.env['ASHLR_HOME'];
    try {
      process.env['HOME'] = home;
      process.env['ASHLR_HOME'] = join(home, '.ashlr');
      mkdirSync(process.env['ASHLR_HOME'], { recursive: true });
      writeFileSync(join(process.env['ASHLR_HOME'], 'agent-network.toml'), identities + slackConfig, { mode: 0o600 });
      const defaults = defaultChannelSources(join(home, 'runs')).slack;
      expect(await defaults.configMissing()).toEqual(configured ? [] : ['slack team identity']);
      const slack: ChannelSource = {
        ...defaults, processAlive: () => true, inbound: () => [], replies: () => [],
        inboundEvidence: undefined, replyBinding: undefined,
      };
      const report = await readChannelHealth({ now: () => new Date('2026-11-12T00:00:00Z'), host: 'fake-host', sources: { slack, imessage: other } });
      const health = report.channels[0]!;
      expect(health.configured).toBe(configured);
      expect(health.state).toBe(configured ? 'LIVE' : 'BLOCKED');
      expect(health.missing).toEqual(configured ? [] : ['slack team identity not configured']);
      expect(JSON.stringify(report)).not.toMatch(/U0FAKEIDENTITY|fake-imessage-identity|T0FAKETEAM|C0FAKECHANNEL/);
    } finally {
      if (savedHome === undefined) delete process.env['HOME']; else process.env['HOME'] = savedHome;
      if (savedAshlr === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = savedAshlr;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
