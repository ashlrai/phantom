import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readHarnessDigest } from '../../src/core/learn/harness-digest-reader.js';

type Digest = NonNullable<ReturnType<typeof readHarnessDigest>>;
type Issue = Digest['issues'][number];

const help = `Usage: npx tsx examples/agents/harness-worklist.ts --file <digest.md>

Print a JSON refresh worklist from a local harness digest. No research is fetched.
`;

/** Run without fetching citations, executing digest content, or writing jobs. */
export function runHarnessWorklist(
  args: string[],
  deps: {
    now?: () => Date;
    read?: typeof readHarnessDigest;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
  } = {},
): number {
  const stdout = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  if (args.length === 1 && args[0] === '--help') {
    stdout(help);
    return 0;
  }
  if (args.length !== 2 || args[0] !== '--file' || !args[1] || args[1].startsWith('--')) {
    stderr('Expected --file <digest.md>. Use --help for usage.\n');
    return 2;
  }
  try {
    const now = (deps.now ?? (() => new Date()))();
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid clock');
    const digest = (deps.read ?? readHarnessDigest)(args[1], now);
    if (!digest) throw new Error('Unreadable digest');
    const ids = new Set(digest.sources.map((source) => source.id));
    const issuesById = new Map<string, Issue['code'][]>();
    for (const issue of digest.issues) {
      const codes = issuesById.get(issue.id) ?? [];
      if (!codes.includes(issue.code)) codes.push(issue.code);
      issuesById.set(issue.id, codes);
    }
    const worklist = digest.sources.flatMap((source) => {
      const issueCodes = issuesById.get(source.id) ?? [];
      if (source.stale !== true && source.checkedAt !== null && issueCodes.length === 0) return [];
      return [{
        id: source.id,
        title: source.title,
        checkedAt: source.checkedAt,
        stale: source.stale,
        urls: source.urls,
        issueCodes,
      }];
    });
    stdout(JSON.stringify({
      v: 1,
      asOf: now.toISOString().slice(0, 10),
      staleDays: 7,
      worklist,
      unmatchedIssues: digest.issues.filter((issue) => !ids.has(issue.id)),
    }, null, 2) + '\n');
    return 0;
  } catch {
    stderr('Unable to read digest as a stable regular file (maximum 1 MiB) or determine the current date.\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runHarnessWorklist(process.argv.slice(2));
}
