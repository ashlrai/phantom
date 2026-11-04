import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathJobHistory } from '../core/fleet/path-job-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const exec = promisify(execFile);
const REF = 'origin/master';
const SCAN_BOUND = 60;
const MAX_BYTES = 16_000;
const usage = 'Usage: ashlr fleet path-batch --stdin [--json]';
type Commit = { sha: string; date: string; subject: string };
type Dependencies = {
  input?: AsyncIterable<string | Uint8Array>;
  log?: (path: string, limit: number) => Promise<Commit[]>;
  output?: (text: string) => void;
  error?: (text: string) => void;
};

async function readInput(input: AsyncIterable<string | Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BYTES) throw new Error('input too large');
    chunks.push(buffer);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

function parsePaths(input: string): string[] {
  // A single-member object also rejects duplicate keys, which JSON.parse discards.
  const string = '"(?:[^"\\\\\\x00-\\x1f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
  const shape = new RegExp(`^\\s*\\{\\s*(${string})\\s*:\\s*\\[\\s*(?:${string}(?:\\s*,\\s*${string})*)?\\s*\\]\\s*\\}\\s*$`);
  const match = shape.exec(input);
  if (!match || JSON.parse(match[1]!) !== 'paths') throw new Error('invalid object');
  const value: unknown = JSON.parse(input);
  const paths = (value as { paths: string[] }).paths;
  if (!paths.length || paths.length > 20 || new Set(paths).size !== paths.length) throw new Error('invalid paths');
  for (const path of paths) {
    if (!path || /[\x00-\x1f\x7f\\]/.test(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some(part => part === '..' || part === '.' || !part)) throw new Error('invalid path');
  }
  return paths;
}

async function gitLog(path: string, limit: number): Promise<Commit[]> {
  const { stdout } = await exec('git', ['--literal-pathspecs', 'log', `-n${limit * 3}`, '--format=%h%x09%cI%x09%s', REF, '--', path],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split('\n').filter(Boolean).map(line => {
    const [sha = '', date = '', ...subject] = line.split('\t');
    return { sha, date, subject: subject.join('\t') };
  });
}

export async function cmdFleetPathBatch(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  if (!args.includes('--stdin') || args.filter(a => a === '--stdin').length !== 1 || args.filter(a => a === '--json').length > 1 || args.some(a => a !== '--stdin' && a !== '--json')) {
    error(usage); return 2;
  }
  let paths: string[];
  try { paths = parsePaths(await readInput(deps.input ?? process.stdin)); }
  catch { error('error: invalid batch input'); return 2; }
  const results: Array<{ path: string; rows?: Awaited<ReturnType<typeof pathJobHistory>>; error?: string }> = [];
  for (const path of paths) {
    try { results.push({ path, rows: await pathJobHistory(path, { log: deps.log ?? gitLog }, { limit: 20 }) }); }
    catch { results.push({ path, error: 'unable to read path history from git' }); }
  }
  const safe = sanitizePublicJson({ schema: 'fleet-path-batch.v1', ref: REF, scanBound: SCAN_BOUND, results }) as { schema: string; ref: string; scanBound: number; results: typeof results };
  if (args.includes('--json')) output(JSON.stringify(safe));
  else {
    output(`Bounded scan: up to ${SCAN_BOUND} commits per path on ${REF}; older history may remain.`);
    for (const result of safe.results) {
      output(`${result.path}:`);
      if (result.error) output(`  error: ${result.error}`);
      else if (!result.rows?.length) output('  No bridge jobs found in this bounded scan; older history may remain.');
      else for (const row of result.rows) output(`  ${row.pr === null ? '#?' : `#${row.pr}`} ${row.jobId} ${row.date} ${row.title}`);
    }
  }
  return results.some(result => result.error) ? 1 : 0;
}
