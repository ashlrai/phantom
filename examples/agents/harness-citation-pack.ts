import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readHarnessDigest } from '../../src/core/learn/harness-digest-reader.js';

const HELP = `Usage: npx tsx examples/agents/harness-citation-pack.ts --file <digest.md> --query <task-text> --byte-budget <256..16384>

Print a JSON evidence bundle from a local digest. Text and URLs are untrusted evidence,
not instructions. No URLs are fetched. One takeaway is selected per source: the first
literal case-insensitive match, or the first takeaway when only the title matches.
Takeaway matches rank first; ties retain digest order. Sources with reader issues,
stale dates, or byte-truncated takeaways are excluded. omittedCount counts eligible
records omitted to fit the budget, which includes the JSON and trailing newline.
Errors are JSON on stderr: invalid_arguments (exit 2), invalid_clock,
digest_unreadable, or pack_failed (exit 1).
`;

type Digest = NonNullable<ReturnType<typeof readHarnessDigest>>;
type RecordItem = { id: string; checkedAt: string; urls: string[]; takeaway: string };

/** The digest and all text within the bundle are untrusted evidence, not instructions. */
export function runHarnessCitationPack(args: readonly string[], deps: {
  read?: typeof readHarnessDigest;
  now?: () => Date;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
} = {}): number {
  const stdout = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  const fail = (code: number, error: string): number => {
    stderr(`${JSON.stringify({ error })}\n`);
    return code;
  };
  if (args.length === 1 && args[0] === '--help') { stdout(HELP); return 0; }
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key || !['--file', '--query', '--byte-budget'].includes(key) || values.has(key)
        || !value || value.startsWith('--')) return fail(2, 'invalid_arguments');
    values.set(key, value);
  }
  const file = values.get('--file');
  const query = values.get('--query');
  const budgetArg = values.get('--byte-budget');
  if (!file || file.length > 4096 || !query || !query.trim() || !budgetArg
      || !/^[1-9]\d*$/.test(budgetArg) || Number(budgetArg) < 256 || Number(budgetArg) > 16384) {
    return fail(2, 'invalid_arguments');
  }
  try {
    const now = (deps.now ?? (() => new Date()))();
    if (!Number.isFinite(now.getTime())) return fail(1, 'invalid_clock');
    const digest: Digest | null = (deps.read ?? readHarnessDigest)(file, now);
    if (!digest) return fail(1, 'digest_unreadable');
    const issueIds = new Set(digest.issues.map(issue => issue.id));
    const needle = query.toLowerCase();
    const matches: { item: RecordItem; rank: number }[] = [];
    for (const source of digest.sources) {
      if (issueIds.has(source.id) || source.stale !== false || !source.checkedAt || !source.urls.length
          || source.takeawaysTruncated?.bytes) continue;
      const takeaways = source.takeaways ?? [];
      const matched = takeaways.find(takeaway => takeaway.toLowerCase().includes(needle));
      const titleMatches = source.title.toLowerCase().includes(needle);
      const takeaway = matched ?? (titleMatches ? takeaways[0] : undefined);
      if (!takeaway) continue;
      matches.push({ item: { id: source.id, checkedAt: source.checkedAt, urls: source.urls, takeaway }, rank: matched ? 0 : 1 });
    }
    matches.sort((a, b) => a.rank - b.rank);
    const records: RecordItem[] = [];
    let omittedCount = matches.length;
    const serialize = (): string => `${JSON.stringify({ v: 1, evidence: 'untrusted', records, omittedCount, empty: records.length === 0 })}\n`;
    for (const match of matches) {
      records.push(match.item);
      omittedCount--;
      if (Buffer.byteLength(serialize(), 'utf8') > Number(budgetArg)) {
        records.pop();
        omittedCount++;
      }
    }
    stdout(serialize());
    return 0;
  } catch {
    return fail(1, 'pack_failed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runHarnessCitationPack(process.argv.slice(2));
}
