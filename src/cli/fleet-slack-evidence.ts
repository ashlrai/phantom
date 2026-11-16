import { isSlackChannelId, isSlackTs } from '../core/agents/slack-network.js';
import { readSlackEvidenceBundle } from '../core/agents/slack-evidence-bundle.js';
import type { SlackRequestTraceOptions } from '../core/agents/slack-request-trace.js';

const usage = 'Usage: phm fleet slack-evidence --thread <ts> [--channel <channel-id>] [--max-age-seconds <positive integer>] --json';

type Deps = SlackRequestTraceOptions & { readBundle?: typeof readSlackEvidenceBundle };

export async function cmdFleetSlackEvidence(args: string[], deps: Deps = {}): Promise<number> {
  let thread: string | undefined;
  let channelId: string | undefined;
  let json = false;
  let maxAgeSeconds: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--thread' && thread === undefined) {
      const value = args[++i];
      if (!isSlackTs(value)) { console.log(usage); return 2; }
      thread = value;
    } else if (arg === '--channel' && channelId === undefined) {
      const value = args[++i];
      if (!isSlackChannelId(value)) { console.log(usage); return 2; }
      channelId = value;
    } else if (arg === '--max-age-seconds' && maxAgeSeconds === undefined) {
      const value = args[++i];
      if (value === undefined || !/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
        console.log(usage); return 2;
      }
      maxAgeSeconds = Number(value);
    } else if (arg === '--help' && args.length === 1) {
      console.log(usage); return 0;
    } else if (arg === '--json' && !json) {
      json = true;
    } else {
      console.log(usage);
      return 2;
    }
  }
  if (thread === undefined || !json) { console.log(usage); return 2; }
  const { readBundle = readSlackEvidenceBundle, ...options } = deps;
  let bundle: ReturnType<typeof readSlackEvidenceBundle>;
  try {
    bundle = readBundle(thread, { ...options,
      ...(channelId !== undefined ? { channelId } : {}),
      ...(maxAgeSeconds !== undefined ? { maxAgeSeconds } : {}) });
  } catch {
    let asOf: string;
    try { asOf = (deps.now ?? (() => new Date()))().toISOString(); }
    catch { asOf = new Date(0).toISOString(); }
    console.log(JSON.stringify({
      schema: 'phantom.fleet.slack-evidence.v1',
      scope: 'Local journal and send evidence only; does not prove current runtime reachability, durable task ownership, or execution.',
      thread, asOf, rows: [],
      counts: { total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 },
      sources: { journal: 'degraded', sends: 'degraded' }, sourceState: 'unavailable',
    }));
    return 1;
  }
  console.log(JSON.stringify(bundle));
  return (maxAgeSeconds === undefined || bundle.freshness?.verdict === 'fresh') && bundle.sources.journal === 'ok' && bundle.sources.sends === 'ok' && bundle.rows.length > 0 &&
    bundle.rows.every((row) => row.outcome === 'answered' && row.ingress !== 'unknown') ? 0 : 1;
}
