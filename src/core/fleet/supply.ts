import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface SupplyCandidate { title: string; source: string }
export type SupplySource = { status: 'ok' | 'unknown'; count: number | null };
const clean = (s: string) => Array.from(s, c => { const code = c.charCodeAt(0); return code < 32 || code === 127 ? ' ' : c; }).join('').replace(/\s+/g, ' ').trim();
export function titleHash(title: string): string {
  return createHash('sha256').update(clean(title).toLowerCase().replace(/[.!?]+$/, '')).digest('hex').slice(0, 16);
}

export function planSupply(candidates: SupplyCandidate[], queue: string, lane: string, n: number) {
  const seen = new Set<string>();
  for (const line of queue.split(/\r?\n/)) {
    const id = line.match(/\bRQ-SUPPLY-([a-f0-9]{16})\b/i);
    if (id) seen.add(id[1]!.toLowerCase());
    const body = line.match(/^\s*-\s+\w+\s+RQ-[^\s]+\s+\([^\n]*?\):\s*(.+)$/i)?.[1];
    if (body) {
      const title = body.split(/\s+Acceptance:\s*/i)[0]!;
      seen.add(titleHash(title));
      seen.add(titleHash(title.split(/(?<=[.!?])\s/)[0]!));
    }
  }
  const lines: string[] = [];
  for (const candidate of candidates) {
    const title = clean(candidate.title).replace(/\s*Acceptance\s*:/ig, ' -');
    if (!title) continue;
    const hash = titleHash(title);
    if (seen.has(hash)) continue;
    seen.add(hash);
    lines.push(`- READY RQ-SUPPLY-${hash} (P1, pool=${lane}, tier=work, repo=phantom, size<=200): ${title} Acceptance: Complete the work described in ${clean(candidate.source)} and add or update relevant tests.`);
    if (lines.length === n) break;
  }
  return lines;
}

export async function readRoadmap(root: string): Promise<SupplyCandidate[]> {
  const text = await readFile(join(root, 'ROADMAP.md'), 'utf8');
  return text.split(/\r?\n/).flatMap((line, i) => {
    const match = line.match(/^\s*[-*]\s+\[ \]\s+(.+?)\s*$/);
    return match ? [{ title: match[1]!, source: `ROADMAP.md:${i + 1}` }] : [];
  });
}

export async function readTodos(root: string): Promise<SupplyCandidate[]> {
  const results: SupplyCandidate[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) {
        const text = await readFile(path, 'utf8');
        text.split(/\r?\n/).forEach((line, i) => {
          const match = line.match(/^\s*\/\/\s*TODO\([^)]+\)\s*:?\s*(.+?)\s*$/);
          if (match) results.push({ title: match[1]!, source: `${relative(root, path)}:${i + 1}` });
        });
      }
    }
  }
  await visit(join(root, 'src'));
  return results;
}

export async function readIssues(): Promise<SupplyCandidate[]> {
  const results: SupplyCandidate[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(`https://api.github.com/repos/ashlrai/phantom/issues?state=open&per_page=100&page=${page}`, { headers: { 'User-Agent': 'phantom-fleet-supply', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('GitHub issues unavailable');
    const data: unknown = await response.json();
    if (!Array.isArray(data)) throw new Error('Invalid issues response');
    for (const issue of data) {
      if (!issue || typeof issue !== 'object' || issue.pull_request || typeof issue.title !== 'string' || typeof issue.number !== 'number' || !Array.isArray(issue.labels)) continue;
      if (/\bTODO\b/i.test(issue.title) || issue.labels.some((label: { name?: unknown }) => typeof label?.name === 'string' && /\bTODO\b/i.test(label.name))) {
        results.push({ title: issue.title, source: `GitHub issue #${issue.number}` });
      }
    }
    if (data.length < 100) return results;
  }
  throw new Error('GitHub issue scan exceeded its page limit');
}
