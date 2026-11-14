import { readChannelHealth, type ChannelHealthDeps } from '../core/fleet/channel-health.js';

const usage = 'Usage: ashlr fleet channel-health [--json]';

/** Exit 0 only when every channel is LIVE; read-only, sends nothing. */
export async function cmdFleetChannelHealth(args: string[], deps: ChannelHealthDeps = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${usage}\nOne read of Slack and iMessage bridge health from receipts and process checks.`);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error(usage);
    return 2;
  }
  const report = await readChannelHealth(deps);
  if (args[0] === '--json') console.log(JSON.stringify(report));
  else {
    console.log(`channel health as of ${report.asOf}`);
    for (const c of report.channels) {
      console.log(`${c.channel}: ${c.state} configured=${c.configured} process=${c.processAlive} host=${c.runtimeHost ?? '-'} ` +
        `lastInbound=${c.lastInboundAt ?? '-'} lastReply=${c.lastReplyAt ?? '-'} unanswered=${c.unansweredCount}`);
      for (const m of c.missing) console.log(`  missing: ${m}`);
    }
  }
  return report.channels.every((c) => c.state === 'LIVE') ? 0 : 1;
}
