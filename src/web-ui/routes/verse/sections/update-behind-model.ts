import type { ServerObservation } from './update-status-queries.js';

export function behindLines(status: ServerObservation): { first: string; moreCount: number; all: string[] } | null {
  if (!status || 'kind' in status || !Array.isArray(status.behindSubjects)) return null;
  const all = status.behindSubjects.filter((subject): subject is string => typeof subject === 'string' && subject.length > 0).slice(0, 5);
  if (all.length === 0) return null;
  return { first: all[0]!, moreCount: Math.max(0, (status.behind ?? all.length) - 1), all };
}
