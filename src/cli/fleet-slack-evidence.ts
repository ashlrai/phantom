import { isSlackChannelId, isSlackTs } from '../core/agents/slack-network.js';
import { readSlackEvidenceBundle } from '../core/agents/slack-evidence-bundle.js';
import type { SlackRequestTraceOptions } from '../core/agents/slack-request-trace.js';

const usage = 'Usage: phm fleet slack-evidence --thread <ts> [--channel <channel-id>] [--message <ts>] [--max-age-seconds <positive integer>] --json';

type Deps = SlackRequestTraceOptions & { readBundle?: typeof readSlackEvidenceBundle };

export async function cmdFleetSlackEvidence(args: string[], deps: Deps = {}): Promise<number> {
  let thread: string | undefined;
  let channelId: string | undefined;
  let message: string | undefined;
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
    } else if (arg === '--message' && message === undefined) {
      const value = args[++i];
      if (!isSlackTs(value)) { console.log(usage); return 2; }
      message = value;
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
  if (thread === undefined || !json || (message !== undefined && channelId === undefined)) { console.log(usage); return 2; }
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
      thread, ...(message !== undefined ? { selection: { channelId, messageTs: message } } : {}), asOf, rows: [],
      counts: { total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 },
      sources: { journal: 'degraded', sends: 'degraded' }, sourceState: 'unavailable',
    }));
    return 1;
  }
  if (message !== undefined) {
    const rows = bundle.rows.filter((row) => row.channelId === channelId && row.messageTs === message);
    const counts = { total: rows.length, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 };
    for (const row of rows) {
      if (row.outcome === 'answered') counts.answered++;
      else if (row.outcome === 'uncertain') counts.uncertain++;
      else if (row.outcome === 'bus-failed') counts.busFailed++;
      else counts.unanswered++;
    }
    bundle = { ...bundle, rows, counts, selection: { channelId, messageTs: message },
      ...(maxAgeSeconds !== undefined ? { freshness: {
        maxAgeSeconds,
        verdict: rows.length === 0 ? 'unknown' : rows.every((row) => {
          const observed = Date.parse(row.at);
          const age = Date.parse(bundle.asOf) - observed;
          return Number.isFinite(observed) && age >= 0 && age / 1000 <= maxAgeSeconds;
        }) ? 'fresh' : 'stale',
        basis: 'Persisted ingress observation times; asOf is collection time, not a live probe.',
      } } : {}),
    } as typeof bundle;
  }
  console.log(JSON.stringify(bundle));
  return (maxAgeSeconds === undefined || bundle.freshness?.verdict === 'fresh') && bundle.sources.journal === 'ok' && bundle.sources.sends === 'ok' && bundle.rows.length > 0 &&
    bundle.rows.every((row) => row.outcome === 'answered' && row.ingress !== 'unknown') ? 0 : 1;
}
