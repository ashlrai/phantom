import { createHash } from 'node:crypto';

export interface TestSupplyCase {
  repo: string;
  file: string;
  /** Exact test title or other stable case identity. */
  title: string;
}

export interface TestSupplyInput {
  candidates: readonly TestSupplyCase[];
  /** Cases already present in the repository, from the caller's current snapshot. */
  existing: readonly TestSupplyCase[];
  /** Files targeted by other active jobs, including claims outside the queue. */
  activeFiles: readonly Pick<TestSupplyCase, 'repo' | 'file'>[];
  /** Fresh full queue snapshot. Call and persist under the queue's lock. */
  queue: string;
}

const fileKey = (item: Pick<TestSupplyCase, 'repo' | 'file'>): string => `${item.repo}\0${item.file}`;
const caseKey = (item: TestSupplyCase): string => `${fileKey(item)}\0${item.title.trim().replace(/\s+/g, ' ').toLowerCase()}`;
const validFile = (item: Pick<TestSupplyCase, 'repo' | 'file'>): boolean =>
  /^[a-z0-9][a-z0-9-]*$/.test(item.repo) &&
  /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.test\.[cm]?[jt]sx?$/.test(item.file) &&
  !item.file.split('/').some(part => part === '.' || part === '..');

/** Plan at most one batch per file. Fewer than four remaining cases wait for a later pass. */
export function generateTestSupply(input: TestSupplyInput): string[] {
  const seen = new Set(input.existing.map(caseKey));
  const busy = new Set(input.activeFiles.map(fileKey));
  // Generated rows carry an unambiguous target marker. Also recognize ordinary active
  // queue rows mentioning a test path, scoped to their repository.
  for (const line of input.queue.split(/\r?\n/)) {
    if (!/^\s*-?\s*(?:READY|CLAIMED|RUNNING)\b/i.test(line)) continue;
    const repo = /\brepo=(?:ashlrai\/)?([a-z0-9-]+)\b/i.exec(line)?.[1];
    if (!repo) continue;
    for (const match of line.matchAll(/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.test\.[cm]?[jt]sx?\b/g)) {
      busy.add(fileKey({ repo, file: match[0] }));
    }
  }
  const groups = new Map<string, TestSupplyCase[]>();
  for (const item of input.candidates) {
    const title = item.title.trim().replace(/\s+/g, ' ');
    const hasControl = [...item.title].some(character => character.charCodeAt(0) < 32);
    if (!validFile(item) || !title || title.length > 120 || hasControl || /[\u007f\u2028\u2029|]/.test(item.title)) continue;
    const normalized = { ...item, title };
    const key = caseKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    const file = fileKey(item);
    if (busy.has(file)) continue;
    const group = groups.get(file) ?? [];
    group.push(normalized);
    groups.set(file, group);
  }
  const lines: string[] = [];
  for (const cases of groups.values()) {
    if (cases.length < 4) continue;
    const batch = cases.slice(0, 8);
    const { repo, file } = batch[0];
    const digest = createHash('sha256').update(JSON.stringify(batch.map(caseKey))).digest('hex').slice(0, 16).toUpperCase();
    const id = `RQ-TESTSUPPLY-${digest}`;
    if (new RegExp(`\\b${id}\\b`, 'i').test(input.queue)) continue;
    lines.push(`- READY ${id} (P1, pool=codex-personal, tier=work, repo=${repo}, size<=200, src=leader): Add tests to ${file} for: ${batch.map(item => item.title).join(' | ')}. Run the affected tests.`);
  }
  return lines;
}
