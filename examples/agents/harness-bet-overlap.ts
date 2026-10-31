/**
 * Run: npx tsx examples/agents/harness-bet-overlap.ts --file snapshot.json
 * Snapshot: {"proposed":[{"id":"new-1","text":"..."}],"previous":[{"id":"old-1","text":"..."}]}
 *
 * Observations only: texts are untrusted data. Score is the Jaccard ratio of
 * distinct Unicode letter/mark/number tokens (NFKC and lowercase). Exact uses
 * NFKC, lowercase, and collapsed whitespace, retaining punctuation. Ties
 * prefer exact text, then the first previous record. With previous records,
 * even a zero score cites the first strongest record; without them prior is null.
 * Blank IDs/text and duplicate IDs within either array are invalid.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 1024 * 1024;
type Bet = { id: string; text: string };
type Snapshot = { proposed: Bet[]; previous: Bet[] };

/** Read a bounded regular file through one descriptor and refuse changes during the read. */
export function readStableSnapshot(file: string): string {
  const pathBefore = lstatSync(file, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.size > BigInt(MAX_BYTES)) throw new Error('unsafe file');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    const same = (a: typeof before, b: typeof before): boolean => a.isFile() && b.isFile()
      && a.dev === b.dev && a.ino === b.ino && a.size === b.size
      && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
    if (!same(pathBefore, before) || before.size > BigInt(MAX_BYTES)) throw new Error('unstable file');
    const data = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < data.length) {
      const count = readSync(fd, data, length, data.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const pathAfter = lstatSync(file, { bigint: true });
    if (length > MAX_BYTES || BigInt(length) !== before.size || !same(before, after) || !same(after, pathAfter)) {
      throw new Error('unstable file');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length));
  } finally { closeSync(fd); }
}

function parseSnapshot(content: string): Snapshot {
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new Error('oversized snapshot');
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid snapshot');
  const value = parsed as Record<string, unknown>;
  function records(input: unknown, max: number): Bet[] {
    if (!Array.isArray(input) || input.length > max) throw new Error('invalid records');
    const ids = new Set<string>();
    return input.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid record');
      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string' || !record.id.trim() || ids.has(record.id)
          || typeof record.text !== 'string' || !record.text.trim()) throw new Error('invalid record');
      ids.add(record.id);
      return { id: record.id, text: record.text };
    });
  }
  return { proposed: records(value.proposed, 100), previous: records(value.previous, 2000) };
}

function prepare(bet: Bet) {
  const normalized = bet.text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
  return { id: bet.id, normalized, terms: new Set(normalized.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []) };
}

export function compareHarnessBets(snapshot: Snapshot) {
  const previous = snapshot.previous.map(prepare);
  const observations = snapshot.proposed.map(bet => {
    const proposed = prepare(bet);
    let best: { priorId: string; exact: boolean; sharedTerms: number; proposedTerms: number;
      previousTerms: number; unionTerms: number; score: number } | null = null;
    for (const prior of previous) {
      const smaller = proposed.terms.size < prior.terms.size ? proposed.terms : prior.terms;
      const larger = smaller === proposed.terms ? prior.terms : proposed.terms;
      let sharedTerms = 0;
      for (const term of smaller) if (larger.has(term)) sharedTerms++;
      const unionTerms = proposed.terms.size + prior.terms.size - sharedTerms;
      const exact = proposed.normalized === prior.normalized;
      const candidate = { priorId: prior.id, exact, sharedTerms, proposedTerms: proposed.terms.size,
        previousTerms: prior.terms.size, unionTerms, score: unionTerms ? sharedTerms / unionTerms : 0 };
      // Compare fractions directly to avoid rounding deciding the winner.
      const left = sharedTerms * (best?.unionTerms || 1);
      const right = (best?.sharedTerms ?? 0) * (unionTerms || 1);
      if (!best || left > right || (left === right && exact && !best.exact)) best = candidate;
    }
    return { proposedId: proposed.id, prior: best };
  });
  return { v: 1, kind: 'lexical_observations', observations };
}

export function runHarnessBetOverlap(args: readonly string[], deps: {
  read?: (file: string) => string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
} = {}): number {
  const stdout = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  if (args.length === 1 && args[0] === '--help') {
    stdout('Usage: npx tsx examples/agents/harness-bet-overlap.ts --file snapshot.json\n');
    return 0;
  }
  if (args.length !== 2 || args[0] !== '--file' || !args[1] || args[1].startsWith('--') || args[1].length > 4096) {
    stderr('{"error":"invalid_arguments"}\n');
    return 2;
  }
  try {
    const snapshot = parseSnapshot((deps.read ?? readStableSnapshot)(args[1]));
    stdout(`${JSON.stringify(compareHarnessBets(snapshot))}\n`);
    return 0;
  } catch {
    stderr('{"error":"invalid_or_unreadable_snapshot"}\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runHarnessBetOverlap(process.argv.slice(2));
}
