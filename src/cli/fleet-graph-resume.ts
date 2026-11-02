import { graphResumeRun } from '../core/fleet/graph-resume-run.js';
import {
  publishGraphTerminalSummary, validGraphObserveRequest,
  type GraphObserveDelivery, type GraphObserveRequest,
} from '../core/fleet/graph-observed-run.js';
import type { BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = 'Usage: ashlr fleet graph-resume --file <absolute manifest> --checkpoint <absolute state file> [--apply] [--concurrency <1..8>] [--timeout-ms <1..3600000>] [--run-id <token> --from <address> --to <address>] --json\n'
  + 'Preview (default) launches nothing and writes nothing; --apply resumes only failed or unfinished nodes once, retaining checkpointed successes.\n'
  + '--run-id/--from/--to are an all-or-none routing group: with --apply, one P2 terminal summary posts to the bus inbox. '
  + 'Addresses are routing labels, never proof of success; a failed delivery exits nonzero without rerunning the graph.';

const ROUTING = ['--run-id', '--from', '--to'];

/**
 * Convention-resolved CLI entry: `ashlr fleet graph-resume`. Without the
 * routing group the JSON result is the raw executor report. With the complete
 * group the report keeps execution and delivery separate: --apply resumes the
 * graph exactly once, then publishGraphTerminalSummary posts one deterministic
 * terminal summary for a complete or failed outcome. Preview and invalid
 * outcomes post nothing, and a retried post dedupes on the stable envelope id.
 */
export async function cmdFleetGraphResume(args: string[], options: BusInboxOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(USAGE);
    return 0;
  }
  let file = '', checkpoint = '', apply = false, json = false, timeout = 900000, concurrency = 1;
  const values = new Map<string, string>();
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return 2;
    seen.add(arg);
    if (arg === '--apply') apply = true;
    else if (arg === '--json') json = true;
    else if (arg === '--file') file = args[++i] ?? '';
    else if (arg === '--checkpoint') checkpoint = args[++i] ?? '';
    else if (ROUTING.includes(arg)) values.set(arg, args[++i] ?? '');
    else if (arg === '--concurrency' && /^[1-8]$/.test(args[i + 1] ?? '')) concurrency = Number(args[++i]);
    else if (arg === '--timeout-ms' && /^\d+$/.test(args[i + 1] ?? '')) timeout = Number(args[++i]);
    else return 2;
  }
  if (!json) return 2;
  const emit = (result: unknown): void => { console.log(JSON.stringify(sanitizePublicJson(result))); };
  if (ROUTING.some(flag => values.has(flag))) {
    const request: GraphObserveRequest = {
      file, runId: values.get('--run-id') ?? '', from: values.get('--from') ?? '', to: values.get('--to') ?? '',
      apply, timeoutMs: timeout,
    };
    if (!validGraphObserveRequest(request)) {
      emit({ status: 'invalid' });
      return 2;
    }
    const execution = await graphResumeRun(file, checkpoint, apply, timeout, concurrency);
    const report = (delivery: GraphObserveDelivery) =>
      ({ schema: 'fleet.graph-resume.run.v1', mode: apply ? 'apply' : 'preview', execution, delivery });
    if (!apply || execution.status === 'invalid') {
      emit(report({ status: 'not-attempted' }));
      return execution.status === 'invalid' ? 2 : 0;
    }
    const delivery = publishGraphTerminalSummary(request.runId, request.from, request.to, execution, options);
    emit(report(delivery));
    return execution.status === 'complete' && ['posted', 'duplicate'].includes(delivery.status) ? 0 : 1;
  }
  const result = await graphResumeRun(file, checkpoint, apply, timeout, concurrency);
  emit(result);
  return result.status === 'invalid' ? 2 : ['preview', 'complete'].includes(result.status) ? 0 : 1;
}
