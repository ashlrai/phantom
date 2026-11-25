import { readChannelHealth, type ChannelHealthDeps } from '../core/fleet/channel-health.js';

const usage = 'Usage: ashlr fleet channel-health [--json]';

/** Exit 0 only when every channel is LIVE; read-only, sends nothing. */
export async function cmdFleetChannelHealth(args: string[], deps: ChannelHealthDeps = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${usage}\nOne read of Slack and iMessage bridge health from receipts and process checks.\nExit 0 means channel health is LIVE; it does not itself prove task assignment, execution, or a request round trip.`);
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
      const ingress = c.proof.durableIngress;
      // These reasons mark paths where the inbound read did not establish coverage.
      // Other UNKNOWN states can still contain usable request observations.
      const inboundUnavailable = !c.configured || c.processAlive === false || c.missing.some((m) =>
        m === `${c.channel} receipt source unreadable` || m === `${c.channel} inbound journal missing`);
      const unanswered = inboundUnavailable && c.unansweredCount === 0 ? 'unknown' : c.unansweredCount;
      const coverage = inboundUnavailable && c.proof.requestCoverage === 'idle' ? 'unknown' : c.proof.requestCoverage;
      console.log(`${c.channel}: ${c.state} configured=${c.configured} process=${c.processAlive} host=${c.runtimeHost ?? '-'} ` +
        `lastInbound=${c.lastInboundAt ?? '-'} lastReply=${c.lastReplyAt ?? '-'} unanswered=${unanswered}` +
        ` coverage=${coverage}` +
        (ingress ? ` ingress=posted:${ingress.posted},dup:${ingress.duplicate},failed:${ingress.failed},unverified:${ingress.unverified}` : '') +
        ` answered=${c.proof.answeredCount ?? 'unknown'} futureDatedExcluded=${c.proof.futureDatedCount}`);
      if (coverage === 'idle') console.log('  No request round trip was verified by this health result.');
      for (const m of c.missing) console.log(`  missing: ${m}`);
    }
  }
  return report.channels.every((c) => c.state === 'LIVE') ? 0 : 1;
}
