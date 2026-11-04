/** Opt-in, evidence-bearing episodic memory. Recorded outcomes are claims, not authority. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { scrubSecrets } from '../util/scrub-secrets.js';

const git = promisify(execFile);
const filePath = z.string().min(1).refine(path => !path.startsWith('/') && !path.includes('\\') &&
  !path.split('/').some(part => part === '..' || part === '.' || part === '') && !path.includes('\0'), 'Expected repository-relative path');
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const evidence = z.object({
  kind: z.enum(['test', 'typecheck', 'command', 'pr']),
  command: z.string().optional(),
  result: z.string(),
  exit_code: z.number().int().optional(),
  pr: z.string().optional(),
});
const entrySchema = z.object({
  id: z.string().uuid(), task_class: z.string().min(1), repo: z.string().min(1), repo_revision: sha,
  files: z.array(z.object({ path: filePath, blob_hash: sha })).min(1),
  claim: z.string().min(1), evidence: z.array(evidence).min(1),
  outcome: z.enum(['success', 'failed', 'partial']), approach: z.string().min(1),
  created_at: z.string().datetime(),
});
export type EpisodicEntry = z.infer<typeof entrySchema>;
export type EpisodicWrite = Pick<EpisodicEntry, 'task_class' | 'repo' | 'claim' | 'evidence' | 'outcome' | 'approach'> & {
  repo_dir: string; files: string[];
};
export interface EpisodicQuery { repo: string; repo_dir: string; task_class: string; files: string[] }
export interface EpisodicRetrieval {
  entries: EpisodicEntry[];
  rejected: { id: string; reason: 'stale'; files: { path: string; reason: 'blob-changed' | 'file-deleted' }[] }[];
}

async function revision(repoDir: string): Promise<string> {
  const { stdout } = await git('git', ['-C', repoDir, 'rev-parse', '--verify', 'HEAD^{commit}'], { timeout: 10_000 });
  return sha.parse(stdout.trim());
}
async function blob(repoDir: string, commit: string, path: string): Promise<string | null> {
  filePath.parse(path);
  const { stdout } = await git('git', ['-C', repoDir, 'ls-tree', '-z', commit, '--', `:(literal)${path}`], { timeout: 10_000 });
  const match = /^\d+ blob ([a-f0-9]+)\t/.exec(stdout);
  return match ? sha.parse(match[1]) : null;
}
// Scrub every free-form field (including metadata and approach), before persistence.
function scrubEntry(entry: EpisodicEntry): EpisodicEntry {
  return entrySchema.parse(JSON.parse(JSON.stringify(entry, (key, value: unknown) =>
    typeof value === 'string' && key !== 'repo_revision' && key !== 'blob_hash' ? scrubSecrets(value) : value)));
}

export class EpisodicMemoryStore {
  constructor(private readonly path = join(homedir(), '.ashlr', 'memory', 'episodic.jsonl')) {}

  private enabled(): boolean { return process.env['PHANTOM_EPISODIC_MEMORY'] === '1'; }

  async write(input: EpisodicWrite): Promise<EpisodicEntry | null> {
    if (!this.enabled()) return null;
    const commit = await revision(input.repo_dir);
    const files = await Promise.all([...new Set(input.files)].map(async path => {
      const hash = await blob(input.repo_dir, commit, path);
      if (!hash) throw new Error('Episodic memory requires a committed file');
      return { path, blob_hash: hash };
    }));
    const entry = scrubEntry(entrySchema.parse({ ...input, files, repo_revision: commit,
      id: randomUUID(), created_at: new Date().toISOString() }));
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
  }

  async retrieve(query: EpisodicQuery): Promise<EpisodicRetrieval> {
    const result: EpisodicRetrieval = { entries: [], rejected: [] };
    if (!this.enabled()) return result;
    query.files.forEach(path => filePath.parse(path));
    let contents: string;
    try { contents = await readFile(this.path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
      throw error;
    }
    const candidates = contents.split('\n').filter(Boolean).map(line => scrubEntry(entrySchema.parse(JSON.parse(line))))
      .filter(entry => entry.repo === query.repo && entry.task_class === query.task_class &&
        entry.files.some(file => query.files.includes(file.path)));
    if (!candidates.length) return result;
    const commit = await revision(query.repo_dir);
    for (const entry of candidates) {
      const stale: EpisodicRetrieval['rejected'][number]['files'] = [];
      for (const file of entry.files) {
        const current = await blob(query.repo_dir, commit, file.path);
        if (current !== file.blob_hash) stale.push({ path: file.path, reason: current === null ? 'file-deleted' : 'blob-changed' });
      }
      if (stale.length) result.rejected.push({ id: entry.id, reason: 'stale', files: stale });
      else result.entries.push(entry);
    }
    return result;
  }
}

/** EVAL-1 condition C hook: same flag, relevance, applicability and evidence contract as runtime callers. */
export async function retrieveEpisodicMemory(query: EpisodicQuery, store = new EpisodicMemoryStore()): Promise<EpisodicRetrieval> {
  return store.retrieve(query);
}
