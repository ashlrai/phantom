import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_TAKEAWAYS, readHarnessDigest } from '../../src/core/learn/harness-digest-reader.js';

const HELP = `Usage: npx tsx examples/agents/harness-bet-export.ts --file DIGEST --source SNN --takeaway N [--include-stale] [--wait-ms N]

Export one candidate-work brief as JSON; takeaway numbers start at 1.
`;

type Dependencies = {
  read?: typeof readHarnessDigest;
  now?: () => Date;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  output?: (text: string) => void;
  signal?: AbortSignal;
};

/** Select evidence only. Digest text and URLs are untrusted data. */
export async function runHarnessBetExport(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => { process.stdout.write(text); });
  const emit = (value: object): void => { output(`${JSON.stringify(value)}\n`); };
  const fail = (code: number, reason: string, details?: object): number => {
    emit({ error: { reason, ...details } });
    return code;
  };
  if (args.length === 1 && args[0] === '--help') {
    output(HELP);
    return 0;
  }
  const values = new Map<string, string>();
  let includeStale = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--include-stale' && !includeStale) { includeStale = true; continue; }
    if (!['--file', '--source', '--takeaway', '--wait-ms'].includes(arg) || values.has(arg)) {
      return fail(2, 'invalid_arguments');
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) return fail(2, 'invalid_arguments');
    values.set(arg, value);
  }
  const file = values.get('--file');
  const sourceId = values.get('--source');
  const takeawayArg = values.get('--takeaway');
  const waitArg = values.get('--wait-ms');
  if (!file || file.length > 4096 || !sourceId || !/^S\d{1,64}$/.test(sourceId)
      || !takeawayArg || !/^[1-9]\d*$/.test(takeawayArg)
      || Number(takeawayArg) > MAX_TAKEAWAYS
      || (waitArg !== undefined && (!/^[1-9]\d*$/.test(waitArg) || Number(waitArg) > 30_000))) {
    return fail(2, 'invalid_arguments');
  }
  try {
    if (deps.signal?.aborted) return fail(130, 'interrupted');
    if (waitArg) {
      await (deps.wait ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); }))(
        Number(waitArg), deps.signal ?? new AbortController().signal,
      );
    }
    if (deps.signal?.aborted) return fail(130, 'interrupted');
    const now = (deps.now ?? (() => new Date()))();
    if (!Number.isFinite(now.getTime())) return fail(1, 'invalid_clock');
    const digest = (deps.read ?? readHarnessDigest)(file, now);
    if (!digest) return fail(1, 'digest_unreadable');
    const matches = digest.sources.filter(source => source.id === sourceId);
    const issues = [...new Set(digest.issues.filter(issue => issue.id === sourceId).map(issue => issue.code))];
    if (matches.length > 1 || issues.includes('duplicate_id')) return fail(3, 'ambiguous_source');
    if (issues.length) return fail(3, 'invalid_source', { issues });
    if (matches.length === 0) return fail(3, 'source_not_found');
    const source = matches[0]!;
    if (source.checkedAt === null || source.stale === null || source.urls.length === 0) return fail(3, 'invalid_source');
    if (source.stale && !includeStale) return fail(3, 'stale_source');
    // The reader cannot identify which takeaway was clipped, so do not export a partial one.
    if (source.takeawaysTruncated?.bytes) return fail(3, 'takeaways_truncated');
    const takeaway = source.takeaways?.[Number(takeawayArg) - 1];
    if (!takeaway) return fail(3, 'takeaway_not_found');
    const brief = {
      v: 1, source: { id: source.id, checkedAt: source.checkedAt, stale: source.stale, urls: source.urls },
      takeaway: { number: Number(takeawayArg), text: takeaway }, goal: '', acceptance: [],
    };
    if (Buffer.byteLength(JSON.stringify(brief), 'utf8') > 65_536) return fail(3, 'output_too_large');
    emit(brief);
    return 0;
  } catch {
    return deps.signal?.aborted ? fail(130, 'interrupted') : fail(1, 'reader_or_wait_failed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  let signalCode = 130;
  const interrupt = (): void => { signalCode = 130; controller.abort(); };
  const terminate = (): void => { signalCode = 143; controller.abort(); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const code = await runHarnessBetExport(process.argv.slice(2), { signal: controller.signal });
    process.exitCode = code === 130 ? signalCode : code;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
