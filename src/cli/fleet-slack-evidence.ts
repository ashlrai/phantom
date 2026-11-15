import { isSlackTs } from '../core/agents/slack-network.js';
import { readSlackEvidenceBundle } from '../core/agents/slack-evidence-bundle.js';
import type { SlackRequestTraceOptions } from '../core/agents/slack-request-trace.js';

const usage = 'Usage: phm fleet slack-evidence --thread <ts> --json';

export async function cmdFleetSlackEvidence(args: string[], deps: SlackRequestTraceOptions = {}): Promise<number> {
  let thread: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--thread' && thread === undefined) {
      const value = args[++i];
      if (!isSlackTs(value)) { console.log(usage); return 2; }
      thread = value;
    } else if (arg === '--json' && !json) {
      json = true;
    } else {
      console.log(usage);
      return 2;
    }
  }
  if (thread === undefined || !json) { console.log(usage); return 2; }
  const bundle = readSlackEvidenceBundle(thread, deps);
  console.log(JSON.stringify(bundle));
  return bundle.sources.journal === 'ok' && bundle.sources.sends === 'ok' && bundle.rows.length > 0 &&
    bundle.rows.every((row) => row.outcome === 'answered' && row.ingress !== 'unknown') ? 0 : 1;
}
