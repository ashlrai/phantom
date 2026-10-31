/**
 * `phm backlog lint` — offline admission lint for the bridge's restock queue.
 * Both the restocker and the queue generator run the same gate: a candidate
 * line is admitted only when it names a concrete file path, a test or
 * acceptance command, a fleet repo with an existing checkout, and only landed
 * dependencies. Every rejected line is logged as an rq-lint-drop event with
 * reasons — drops are never silent. Read-only: it never edits the queue.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { lintRestockDocument, restockReposRoot, type LintReason, type RestockLintOptions } from '../core/portfolio/restock-lint.js';
import { RQ_MAX_FILE_BYTES, rqDigest } from '../core/portfolio/rq-backlog.js';

export const BACKLOG_LINT_USAGE = 'phm backlog lint --queue <router-queue.md> [--landed <ids.txt>] [--repos-root <dir>] [--pools <csv>] [--json]';

const LINT_FLAGS = ['--queue', '--landed', '--repos-root', '--pools'];
const REASONS: readonly LintReason[] = [
  'unparseable', 'bad-id', 'dup-line', 'no-repo', 'bad-repo', 'repo-folder-missing',
  'github-protected', 'no-file-path', 'no-test-command', 'bad-dep', 'unlanded-dep', 'unknown-pool',
];

async function readBounded(path: string): Promise<string> {
  // One bounded read through the same descriptor: size checks cannot be
  // defeated by replacing/growing a file between stat and readFile.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > RQ_MAX_FILE_BYTES) throw new Error('Invalid snapshot file');
    const buffer = Buffer.alloc(RQ_MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > RQ_MAX_FILE_BYTES) throw new Error('Snapshot is too large');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
  } finally { await file.close(); }
}

/** One landed dep token per line: job ids and PR references, no comment syntax. */
function parseLanded(text: string): Set<string> {
  const landed = new Set<string>();
  for (const line of text.split('\n')) {
    const token = line.trim();
    if (token) landed.add(token);
  }
  return landed;
}

export async function cmdBacklogLint(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(BACKLOG_LINT_USAGE);
    console.log('Offline, read-only. stdout: admitted READY lines (or --json report); stderr: one rq-lint-drop event per rejected line.');
    console.log('Reject reasons: ' + REASONS.join(', '));
    return 0;
  }
  const flags = new Map<string, string>();
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--json' && !json) { json = true; continue; }
    const value = args[index + 1];
    if (!LINT_FLAGS.includes(arg) || flags.has(arg) || !value || value.startsWith('--')) {
      console.error(JSON.stringify({ event: 'rq-lint-error', code: 'usage' }));
      return 2;
    }
    flags.set(arg, value);
    index++;
  }
  if (!flags.has('--queue')) {
    console.error(JSON.stringify({ event: 'rq-lint-error', code: 'usage' }));
    return 2;
  }
  try {
    const queue = await readBounded(flags.get('--queue')!);
    const options: RestockLintOptions = {};
    if (flags.has('--landed')) options.landed = parseLanded(await readBounded(flags.get('--landed')!));
    if (flags.has('--repos-root')) options.reposRoot = flags.get('--repos-root');
    else options.reposRoot = restockReposRoot();
    if (flags.has('--pools')) options.pools = new Set(flags.get('--pools')!.split(',').map((pool) => pool.trim()).filter(Boolean));
    const report = lintRestockDocument(queue, options);
    for (const drop of report.drops) {
      // The logged drop event replaces the dispatcher's silent drop: one event
      // per rejected line, carrying reasons and a hash for correlation — never
      // the untrusted line text itself.
      console.error(JSON.stringify({ event: 'rq-lint-drop', line: drop.line, job: drop.jobId, reasons: drop.reasons, sha: drop.sha }));
    }
    console.error(JSON.stringify({
      event: 'rq-lint', queueSha: rqDigest(queue), candidates: report.candidates,
      accepted: report.accepted.length, dropped: report.drops.length,
    }));
    if (json) {
      process.stdout.write(JSON.stringify({
        v: 1, queueSha: rqDigest(queue), candidates: report.candidates,
        accepted: report.accepted.map((candidate) => ({ line: candidate.line, job: candidate.jobId, repo: candidate.repo, deps: candidate.deps, escalation: candidate.escalation })),
        drops: report.drops,
      }) + '\n');
    } else if (report.accepted.length > 0) {
      process.stdout.write(report.accepted.map((candidate) => candidate.raw + '\n').join(''));
    }
    return report.drops.length > 0 ? 1 : 0;
  } catch {
    // Neither queue text nor filesystem errors (which can contain private
    // paths) belong in logs. An unreadable queue must never count as clean.
    console.error(JSON.stringify({ event: 'rq-lint-error', code: 'invalid-snapshot' }));
    return 2;
  }
}
