/**
 * `ashlr fleet landed-close` — close DIRTY bridge PRs whose every changed path
 * already matches master (class `landed` in `fleet dirty-landed`): the work
 * shipped another way and the PR adds nothing.
 *
 *   ashlr fleet dirty-landed --json | ashlr fleet landed-close --apply
 *
 * Input is a `fleet.dirty-landed.v1` report (--from <file>, or stdin when
 * --from is `-` or omitted). Dry run by default: it prints the plan and never
 * runs gh. With --apply each PR is re-read first (`gh pr view`) and skipped as
 * `head-moved` unless it is still OPEN at the head the report saw; then
 * `gh pr close` runs. The first non-zero close stops the run. Every attempt is
 * appended to <runsDir>/queue/landed-closes.jsonl (mode 0600).
 *
 * The report type is deliberately local — fleet-dirty-landed.ts is owned by
 * another job and is not imported.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultGitRunner } from '../core/verse/git-ops.js';

const REPO = 'ashlrai/phantom';
const SCHEMA = 'fleet.dirty-landed.v1';
const USAGE = 'Usage: ashlr fleet landed-close [--from <file>|-] [--apply] [--limit N] [--json]';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const BRIDGE_TITLE = /^bridge: RQ-PHX-/;
const SHA = /^[0-9a-f]{40}$/;
const COMMENT = 'Closed by ashlr fleet landed-close: every changed path already matches master at the time of the check.';

export type LandedCloseRunner =
  (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface FleetLandedCloseDeps {
  runner?: LandedCloseRunner;
  runsDir?: string;
  /** Stdin reader; defaults to process.stdin. */
  stdin?: () => Promise<string>;
  now?: () => number;
}

interface LandedRow { number: number; title: string; head: string; paths: number }
type Outcome = 'closed' | 'skipped' | 'failed';
interface Attempt { pr: number; head: string; outcome: Outcome; reason?: string }

const defaultRunner: LandedCloseRunner = async (_file, args) => {
  const result = await defaultGitRunner('gh', args, {
    cwd: tmpdir(), timeoutMs: 60_000, maxStdoutBytes: 4 * 1024 * 1024,
  });
  return {
    code: result.code ?? 1,
    stdout: result.stdout,
    stderr: result.stderr || (result.missing ? 'gh binary not found' : result.timedOut ? 'gh timed out' : ''),
  };
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

interface ParsedArgs { from: string; apply: boolean; json: boolean; limit: number }

function parseArgs(args: readonly string[]): ParsedArgs | 'help' | null {
  const out: ParsedArgs = { from: '-', apply: false, json: false, limit: DEFAULT_LIMIT };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--apply') out.apply = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--from') {
      const value = args[++i];
      if (value === undefined) return null;
      out.from = value;
    } else if (arg === '--limit') {
      const value = args[++i];
      if (value === undefined || !/^\d+$/.test(value)) return null;
      out.limit = Math.min(Number(value), MAX_LIMIT);
    } else return null;
  }
  return out;
}

/** Returns the plan, or null when the report is not a dirty-landed v1 report. */
function planRows(text: string): LandedRow[] | null {
  let report: unknown;
  try { report = JSON.parse(text); } catch { return null; }
  if (typeof report !== 'object' || report === null) return null;
  const { schema, prs } = report as { schema?: unknown; prs?: unknown };
  if (schema !== SCHEMA || !Array.isArray(prs)) return null;
  const rows: LandedRow[] = [];
  for (const pr of prs as unknown[]) {
    if (typeof pr !== 'object' || pr === null) continue;
    const r = pr as Record<string, unknown>;
    if (r.class !== 'landed' || !Number.isSafeInteger(r.number) || (r.number as number) <= 0) continue;
    if (typeof r.title !== 'string' || !BRIDGE_TITLE.test(r.title)) continue;
    if (typeof r.head !== 'string' || !SHA.test(r.head)) continue;
    if (!Array.isArray(r.changedPaths) || r.changedPaths.length === 0) continue;
    rows.push({ number: r.number as number, title: r.title, head: r.head, paths: r.changedPaths.length });
  }
  return rows;
}

/** Re-read the PR: null when it is still OPEN at the planned head, else the skip reason. */
async function skipReason(run: LandedCloseRunner, row: LandedRow): Promise<string | null> {
  const view = await run('gh', ['pr', 'view', String(row.number), '--repo', REPO, '--json', 'headRefOid,state']);
  if (view.code !== 0) return 'view-failed';
  try {
    const live = JSON.parse(view.stdout) as { headRefOid?: unknown; state?: unknown };
    return live.headRefOid === row.head && live.state === 'OPEN' ? null : 'head-moved';
  } catch { return 'view-failed'; }
}

export async function cmdFleetLandedClose(args: string[], deps: FleetLandedCloseDeps = {}): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed === 'help') { console.log(USAGE); return 0; }
  if (parsed === null) { process.stderr.write(`${USAGE}\n`); return 2; }

  let text: string;
  try {
    text = parsed.from === '-' ? await (deps.stdin ?? readStdin)() : await readFile(parsed.from, 'utf8');
  } catch {
    process.stderr.write('fleet landed-close: cannot read input\n'); return 1;
  }
  const rows = planRows(text);
  if (rows === null) {
    process.stderr.write(`fleet landed-close: input is not a ${SCHEMA} report\n`); return 1;
  }

  const attempts: Attempt[] = [];
  let error: string | undefined;
  if (parsed.apply) {
    const run = deps.runner ?? defaultRunner;
    const now = deps.now ?? (() => Date.now());
    const runsDir = deps.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
    const ledger = join(runsDir, 'queue', 'landed-closes.jsonl');
    try {
      await mkdir(join(runsDir, 'queue'), { recursive: true });
      for (const row of rows.slice(0, parsed.limit)) {
        const attempt: Attempt = { pr: row.number, head: row.head, outcome: 'closed' };
        try {
          const skip = await skipReason(run, row);
          if (skip !== null) {
            attempt.outcome = 'skipped'; attempt.reason = skip;
          } else {
            const result = await run('gh', ['pr', 'close', String(row.number), '--repo', REPO, '--comment', COMMENT]);
            if (result.code !== 0) {
              attempt.outcome = 'failed';
              attempt.reason = result.stderr.trim() || `gh pr close exited ${result.code}`;
            }
          }
        } catch (err) {
          attempt.outcome = 'failed'; attempt.reason = err instanceof Error ? err.message : String(err);
        }
        attempts.push(attempt);
        // Ledger first: a write failure stops the run rather than closing PRs unaudited.
        await appendFile(ledger, `${JSON.stringify({ at: new Date(now()).toISOString(), ...attempt })}\n`,
          { encoding: 'utf8', mode: 0o600 });
        if (attempt.outcome === 'failed') { error = attempt.reason; break; }
      }
    } catch {
      process.stderr.write('fleet landed-close: ledger write failed\n'); return 1;
    }
  }

  const count = (outcome: Outcome): number => attempts.filter(a => a.outcome === outcome).length;
  const failed = count('failed');
  if (parsed.json) {
    console.log(JSON.stringify({
      repo: REPO, apply: parsed.apply, limit: parsed.limit,
      planned: rows.length, attempted: attempts.length,
      closed: count('closed'), skipped: count('skipped'), failed,
      rows: rows.map(row => ({ ...row, ...(attempts.find(a => a.pr === row.number) ?? {}) })),
      ...(error === undefined ? {} : { error }),
    }));
  } else if (!parsed.apply) {
    for (const row of rows) console.log(`#${row.number} ${row.title} -> all ${row.paths} paths on master`);
    console.log('dry run: add --apply to close');
  } else {
    for (const a of attempts) console.log(`${a.outcome} #${a.pr}${a.reason ? `: ${a.reason}` : ''}`);
    console.log(`closed ${count('closed')}, skipped ${count('skipped')}, failed ${failed}; ${rows.length - attempts.length} not attempted`);
  }
  return failed > 0 ? 1 : 0;
}
