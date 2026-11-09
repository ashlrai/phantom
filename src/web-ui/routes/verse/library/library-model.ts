/**
 * routes/verse/library/library-model.ts: pure helpers for the Library pane.
 * Everything here is plain data in, plain data out; all text stays untrusted.
 */
import type { VerseSession } from '../../../data/api-types.js';
import type { VerseProjectMemoryView } from '../context/context-queries.js';
import { projectName } from '../verse-model.js';

export const PREVIEW_LINES = 3;
export const PREVIEW_LINE_MAX_CHARS = 160;
/** The server refuses a shorter query (session-search.ts). */
export const SEARCH_MIN_CHARS = 2;

export interface RecentProject {
  path: string;
  name: string;
  chats: number;
  /** Newest session time in ms; 0 when no session carried a readable time. */
  latest: number;
}

/** Distinct projects, newest activity first, with a display name and chat count. */
export function recentProjects(sessions: readonly Pick<VerseSession, 'projectPath' | 'updatedAt' | 'createdAt'>[], limit = 8): RecentProject[] {
  const byPath = new Map<string, RecentProject>();
  for (const session of sessions) {
    if (!session.projectPath) continue;
    const parsed = Date.parse(session.updatedAt || session.createdAt);
    const time = Number.isFinite(parsed) ? parsed : 0;
    const known = byPath.get(session.projectPath);
    if (known) {
      known.chats += 1;
      known.latest = Math.max(known.latest, time);
    } else {
      byPath.set(session.projectPath, { path: session.projectPath, name: projectName(session.projectPath), chats: 1, latest: time });
    }
  }
  return [...byPath.values()].sort((a, b) => b.latest - a.latest || a.path.localeCompare(b.path)).slice(0, Math.max(0, limit));
}

export interface MemorySummary {
  lines: number;
  bytes: number;
  preview: string[];
  sanitized: boolean;
  empty: boolean;
}

export function memorySummary(memory: Pick<VerseProjectMemoryView, 'content' | 'bytes' | 'contentSanitized'>): MemorySummary {
  const nonEmpty = memory.content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return {
    lines: nonEmpty.length,
    bytes: memory.bytes,
    preview: nonEmpty.slice(0, PREVIEW_LINES).map((line) => line.trim().slice(0, PREVIEW_LINE_MAX_CHARS)),
    sanitized: memory.contentSanitized === true,
    empty: nonEmpty.length === 0,
  };
}

export function searchQueryValid(q: string): boolean {
  return q.trim().length >= SEARCH_MIN_CHARS;
}
