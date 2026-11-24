import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { semanticDedupe } from './semantic-dedupe.js';

export interface DedupeRepeat { id: string; repeatOf: string; repo: string; file: string; match: 'acceptance' | 'quoted' | 'semantic-goal'; reason?: 'semantic-goal-overlap'; jaccard?: number; }
export interface DedupeReport { schema: 'queue.dedupe.v1'; count: number; repeats: DedupeRepeat[]; unknown: { id: string | null; line: number; reason: string }[]; applied: boolean; }
const filePattern = /(?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|mjs|cjs|jsx?|py|rs|go|md|json|ya?ml|toml|sh|css|html)\b/i;
const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Plan only from explicit evidence; preserve all unrecognized lines verbatim. */
export function dedupeQueue(text: string): { report: DedupeReport; output: string } {
  const seen = new Map<string, { id: string; acceptance: string; quoted: string | null }[]>();
  const repeats: DedupeRepeat[] = [];
  const output = text.split(/(?<=\n)/).map((line) => {
    const status = /^\s*-\s+(READY|CLAIMED)\b/.exec(line);
    if (!status) return line;
    const id = status[1] === 'READY' ? /^\s*-\s+READY\s+(RQ-[\w.-]+)/.exec(line)?.[1] : /^\s*-\s+CLAIMED\s+\S+\s+\S+\s+(RQ-[\w.-]+)/.exec(line)?.[1];
    const repo = /\brepo\s*=\s*([\w.-]+)/i.exec(line)?.[1]?.toLowerCase();
    const acceptanceAt = line.search(/\bacceptance\s*:/i);
    const file = filePattern.exec(acceptanceAt < 0 ? line : line.slice(0, acceptanceAt))?.[0]?.toLowerCase();
    const acceptanceText = acceptanceAt < 0 ? '' : line.slice(acceptanceAt).replace(/^acceptance\s*:/i, '').trim();
    const acceptance = normalize(acceptanceText);
    const quoted = /["“]([^"”]+)["”]|`([^`]+)`|'([^']+)'/.exec(acceptanceText);
    const identifier = quoted ? normalize(quoted[1] ?? quoted[2] ?? quoted[3] ?? '') || null : null;
    if (!id || !repo || !file || !acceptance) {
      return line;
    }
    const key = `${repo}\n${file}`;
    const prior = seen.get(key) ?? [];
    const first = prior.find(row => row.acceptance === acceptance || (identifier !== null && row.quoted === identifier));
    if (first && status[1] === 'READY' && first.id !== id) {
      repeats.push({ id, repeatOf: first.id, repo, file, match: first.acceptance === acceptance ? 'acceptance' : 'quoted' });
      return line.replace(/^(\s*-\s+)READY\b/, `$1SUPERSEDED-BY-${first.id}`);
    }
    prior.push({ id, acceptance, quoted: identifier });
    seen.set(key, prior);
    return line;
  }).join('');
  const semantic = semanticDedupe(output);
  repeats.push(...semantic.repeats);
  return { report: { schema: 'queue.dedupe.v1', count: repeats.length, repeats, unknown: semantic.unknown, applied: false }, output: semantic.output };
}

// Share the dispatcher's advisory lock and refuse to overwrite a changed snapshot.
const writer = `import fcntl, json, os, stat, sys, tempfile
path, lockpath = sys.argv[1:]
data = json.load(sys.stdin)
with open(lockpath, 'a') as lock:
 fcntl.flock(lock, fcntl.LOCK_EX)
 info = os.lstat(path)
 if not stat.S_ISREG(info.st_mode): raise ValueError('Queue must be a regular file')
 with open(path, encoding='utf-8', newline='') as source: current = source.read()
 if current != data['before']: raise ValueError('Queue changed; run dedupe again')
 fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.dedupe-')
 try:
  os.fchmod(fd, stat.S_IMODE(info.st_mode))
  with os.fdopen(fd, 'w', encoding='utf-8', newline='') as out:
   out.write(data['after']); out.flush(); os.fsync(out.fileno())
  os.replace(tmp, path)
 finally:
  if os.path.exists(tmp): os.unlink(tmp)
`;
/** Swap the queue text under the dispatcher's lock. Throws when the file changed since `before` was read. */
export function replaceQueueText(path: string, before: string, after: string): void {
  const result = spawnSync('python3', ['-c', writer, path, `${dirname(path)}/ready.lock`], { input: JSON.stringify({ before, after }), encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) throw new Error('Could not update queue; it may be locked or have changed');
}
export async function dedupeQueueFile(path: string, apply = false): Promise<DedupeReport> {
  const before = await readFile(path, 'utf8');
  const { report, output } = dedupeQueue(before);
  if (apply && report.count) {
    replaceQueueText(path, before, output);
    report.applied = true;
  }
  return report;
}
