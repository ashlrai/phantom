import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readHarnessDigest } from '../../src/core/learn/harness-digest-reader.js';

type Digest = NonNullable<ReturnType<typeof readHarnessDigest>>;
type Source = Digest['sources'][number];
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const usage = 'Usage: npx tsx examples/agents/harness-digest-diff.ts --before <digest.md> --after <digest.md>';

function normalize(source: Source): Source {
  return {
    ...source,
    urls: [...new Set(source.urls)].sort(),
    ...(source.takeaways ? { takeaways: [...new Set(source.takeaways)].sort() } : {}),
  };
}

function group(sources: Source[]): Map<string, Source[]> {
  const groups = new Map<string, Source[]>();
  for (const source of sources) {
    const entries = groups.get(source.id) ?? [];
    entries.push(normalize(source));
    groups.set(source.id, entries);
  }
  return groups;
}

function difference(left: string[], right: string[]): string[] {
  const other = new Set(right);
  return left.filter((item) => !other.has(item));
}

/** Compare reader projections without guessing which duplicate entries correspond. */
export function compareHarnessDigests(before: Digest, after: Digest) {
  const oldGroups = group(before.sources);
  const newGroups = group(after.sources);
  const ids = [...new Set([...oldGroups.keys(), ...newGroups.keys()])].sort();
  const addedSources: Source[] = [];
  const removedSources: Source[] = [];
  const ambiguousSources: { id: string; before: Source[]; after: Source[] }[] = [];
  const checkedDateChanges: { id: string; before: string | null; after: string | null }[] = [];
  const semanticChanges: {
    id: string; before: Source; after: Source;
    addedTakeaways: string[]; removedTakeaways: string[];
    addedUrls: string[]; removedUrls: string[]; titleChanged: boolean;
  }[] = [];

  for (const id of ids) {
    const oldEntries = oldGroups.get(id) ?? [];
    const newEntries = newGroups.get(id) ?? [];
    if (oldEntries.length > 1 || newEntries.length > 1) {
      ambiguousSources.push({ id, before: oldEntries, after: newEntries });
      continue;
    }
    const oldSource = oldEntries[0];
    const newSource = newEntries[0];
    if (!oldSource && newSource) { addedSources.push(newSource); continue; }
    if (oldSource && !newSource) { removedSources.push(oldSource); continue; }
    if (!oldSource || !newSource) continue;
    if (oldSource.checkedAt !== newSource.checkedAt) {
      checkedDateChanges.push({ id, before: oldSource.checkedAt, after: newSource.checkedAt });
    }
    const addedTakeaways = difference(newSource.takeaways ?? [], oldSource.takeaways ?? []);
    const removedTakeaways = difference(oldSource.takeaways ?? [], newSource.takeaways ?? []);
    const addedUrls = difference(newSource.urls, oldSource.urls);
    const removedUrls = difference(oldSource.urls, newSource.urls);
    const titleChanged = oldSource.title !== newSource.title;
    if (addedTakeaways.length || removedTakeaways.length || addedUrls.length || removedUrls.length || titleChanged) {
      semanticChanges.push({ id, before: oldSource, after: newSource, addedTakeaways, removedTakeaways, addedUrls, removedUrls, titleChanged });
    }
  }
  return {
    v: 1, addedSources, removedSources, checkedDateChanges, semanticChanges, ambiguousSources,
    health: { before: before.issues, after: after.issues },
    // Even unchanged sources may have clipped takeaways, making a comparison incomplete.
    truncatedTakeaways: {
      before: before.sources.filter((source) => source.takeawaysTruncated).map(normalize),
      after: after.sources.filter((source) => source.takeawaysTruncated).map(normalize),
    },
  };
}

/** Run synchronously; there are no background tasks, waits, or signal handlers. */
export function runHarnessDigestDiff(
  args: readonly string[],
  deps: {
    read?: typeof readHarnessDigest;
    now?: () => Date;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
  } = {},
): number {
  const stdout = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  const fail = (code: number, error: string): number => {
    stderr(`${JSON.stringify({ error })}\n`);
    return code;
  };
  if (args.length === 1 && args[0] === '--help') {
    stdout(`${usage}\n`);
    return 0;
  }
  if (args.length !== 4 || !['--before', '--after'].includes(args[0] ?? '') ||
      !['--before', '--after'].includes(args[2] ?? '') || args[0] === args[2] ||
      !args[1] || !args[3] || args[1].startsWith('--') || args[3].startsWith('--') ||
      args[1].length > 4096 || args[3].length > 4096) {
    return fail(2, usage);
  }
  const files = args[0] === '--before' ? [args[1], args[3]] : [args[3], args[1]];
  try {
    const now = (deps.now ?? (() => new Date()))();
    if (!Number.isFinite(now.getTime())) return fail(1, 'Current date unavailable');
    const read = deps.read ?? readHarnessDigest;
    const before = read(files[0]!, now);
    if (!before) return fail(1, 'Before digest unavailable or unsafe to read');
    const after = read(files[1]!, now);
    if (!after) return fail(1, 'After digest unavailable or unsafe to read');
    const result = JSON.stringify({ asOf: now.toISOString().slice(0, 10), ...compareHarnessDigests(before, after) });
    if (Buffer.byteLength(result, 'utf8') > MAX_OUTPUT_BYTES) return fail(1, 'Comparison exceeds output limit');
    stdout(`${result}\n`);
    return 0;
  } catch {
    return fail(1, 'Digest comparison unavailable');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runHarnessDigestDiff(process.argv.slice(2));
}
