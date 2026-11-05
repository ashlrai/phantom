import { pathCochanges, validCochangesPath } from '../core/fleet/path-cochanges.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet path-cochanges (<literal-relative-path> | --stdin) [--limit N] [--json]\n--stdin reads one JSON string (up to 16 KiB).' ;
type Dependencies = {
  read?: typeof pathCochanges;
  stdin?: AsyncIterable<Uint8Array>;
  output?: (text: string) => void;
  error?: (text: string) => void;
};

const STDIN_LIMIT = 16 * 1024;

async function readStdinPath(input: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.byteLength;
    if (size > STDIN_LIMIT) throw new Error();
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

/** Report bounded cochange evidence without treating it as an editing permission. */
export async function cmdFleetPathCochanges(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { output(usage); return 0; }
  let path: string | undefined;
  let limit = 20;
  let json = false;
  let sawLimit = false;
  let positionalOnly = false;
  let stdin = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!positionalOnly && arg === '--') { positionalOnly = true; continue; }
    if (!positionalOnly && arg === '--stdin' && !stdin) { stdin = true; continue; }
    if (!positionalOnly && arg === '--json' && !json) { json = true; continue; }
    if (!positionalOnly && arg === '--limit' && !sawLimit) {
      sawLimit = true;
      const value = args[++i];
      if (value === undefined || !/^\d+$/.test(value)) { error(usage); return 2; }
      limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) { error(usage); return 2; }
      continue;
    }
    if ((!positionalOnly && arg.startsWith('-')) || path !== undefined) { error(usage); return 2; }
    path = arg;
  }
  if (stdin && path !== undefined) { error(usage); return 2; }
  if (stdin) {
    try {
      const value = await readStdinPath(deps.stdin ?? process.stdin);
      if (typeof value !== 'string') { error(usage); return 2; }
      path = value;
    } catch { error(usage); return 2; }
  }
  if (path === undefined || !validCochangesPath(path)) { error(usage); return 2; }
  try {
    const safe = sanitizePublicJson(await (deps.read ?? pathCochanges)(path, { limit })) as Awaited<ReturnType<typeof pathCochanges>>;
    if (json) { output(JSON.stringify(safe)); return 0; }
    output(`Cochanges for ${safe.path} at ${safe.resolvedRef}: sampled ${safe.sampledCount} commits, examined ${safe.examinedCount} bridge commits.`);
    for (const row of safe.paths) {
      output(`  ${JSON.stringify(row.path)}: ${row.count} commit(s)`);
      for (const evidence of row.evidence) output(`    ${evidence.sha} ${evidence.jobId}`);
    }
    if (!safe.paths.length) output('  No companion paths observed in this sample.');
    output(`Truncation: commits=${safe.commitsTruncated}, matches=${safe.matchesTruncated}, paths=${safe.pathsTruncated}; omitted paths=${safe.omittedPaths}.`);
    output(safe.notice);
    return 0;
  } catch {
    error('error: unable to read path cochanges from git');
    return 1;
  }
}
