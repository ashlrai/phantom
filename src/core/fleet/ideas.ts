import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Idea { id: string; repo: string | null; lane: string | null; goal: string }
export interface IdeasReport { schema: 'fleet.ideas.v1'; ideas: Idea[]; missing: string[] }

/** Vision order is the ranking; queue-only jobs follow in queue order. */
export function parseIdeas(vision: string, queue: string): Idea[] {
  const ideas = new Map<string, Idea>();
  for (const line of `${vision}\n${queue}`.split(/\r?\n/)) {
    const match = /^\s*- READY (RQ-[A-Za-z0-9_-]+)\s*(?:\(([^)]*)\))?\s*:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const metadata = match[2] ?? '';
    const field = (key: string) => new RegExp(`(?:^|[,\\s])${key}=([A-Za-z0-9._/-]+)`).exec(metadata)?.[1] ?? null;
    const idea = { id: match[1]!, repo: field('repo'), lane: field('pool') ?? field('lane'), goal: match[3]! };
    const existing = ideas.get(idea.id);
    if (existing) {
      existing.repo ??= idea.repo;
      existing.lane ??= idea.lane;
    } else ideas.set(idea.id, idea);
  }
  return [...ideas.values()];
}

export async function readIdeas(root = join(homedir(), '.ashlr-runs')): Promise<IdeasReport> {
  const missing: string[] = [];
  const read = async (path: string) => {
    try { return await readFile(join(root, path), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.push(path);
      return '';
    }
  };
  const vision = await read('leader/VISION.md');
  const queue = await read('queue/router-queue.md');
  return { schema: 'fleet.ideas.v1', ideas: parseIdeas(vision, queue), missing };
}
