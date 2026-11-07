import { graphObservedRun, validGraphObserveRequest, type GraphObserveRequest } from '../core/fleet/graph-observed-run.js';
import type { BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = 'Usage: ashlr fleet graph-observe --file <absolute manifest> --run-id <token> --from <address> --to <address> [--apply] [--timeout-ms <1..3600000>] [--json]\n'
  + 'Preview (default) launches nothing and writes nothing; --apply runs the real graph once, then posts one P2 terminal summary.\n'
  + 'Reusing a run-id does not make execution idempotent — dedupe is transport-only. Addresses are routing labels, never proof of success.';

/**
 * Convention-resolved CLI entry: `ashlr fleet graph-observe`. Emits one
 * scrubbed JSON record keeping the execution result and the delivery result
 * separate, and never runs the graph twice for a single invocation.
 */
export async function cmdFleetGraphObserve(args: string[], options: BusInboxOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(USAGE);
    return 0;
  }
  const values = new Map<string, string>();
  let apply = false, json = false, invalid = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--apply') { if (apply) { invalid = true; break; } apply = true; continue; }
    if (key === '--json') { if (json) { invalid = true; break; } json = true; continue; }
    if (!['--file', '--run-id', '--from', '--to', '--timeout-ms'].includes(key) || values.has(key)) { invalid = true; break; }
    const value = args[++i];
    if (!value || value.startsWith('--')) { invalid = true; break; }
    values.set(key, value);
  }
  const timeout = values.get('--timeout-ms');
  const request: GraphObserveRequest = {
    file: values.get('--file')!, runId: values.get('--run-id')!,
    from: values.get('--from')!, to: values.get('--to')!,
    apply, timeoutMs: timeout === undefined ? 900_000 : /^\d+$/.test(timeout) ? Number(timeout) : NaN,
  };
  const emit = (result: unknown): number => { console.log(JSON.stringify(sanitizePublicJson(result))); return 0; };
  if (invalid || [request.file, request.runId, request.from, request.to].some(v => v === undefined) || !validGraphObserveRequest(request)) {
    emit({ status: 'invalid' });
    return 2;
  }
  const result = await graphObservedRun(request, options);
  emit(result);
  if (result.execution.status === 'invalid') return 2;
  if (result.mode === 'preview') return result.delivery.status === 'preview' ? 0 : 1;
  const delivered = result.delivery.status === 'posted' || result.delivery.status === 'duplicate';
  return result.execution.status === 'complete' && delivered ? 0 : 1;
}
