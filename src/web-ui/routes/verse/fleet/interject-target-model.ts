export function mentionQuery(text: string, caret: number): string | null {
  if (caret < 0 || caret > text.length) return null;
  const match = /(?:^|\s)@([A-Za-z0-9-]*)$/.exec(text.slice(0, caret));
  return match ? match[1]! : null;
}

export function matchRunningJobs<T extends { job: string }>(query: string, jobs: readonly T[], limit = 6): T[] {
  const needle = query.toLowerCase();
  return jobs.filter(job => job.job.toLowerCase().includes(needle)).slice(0, Math.max(0, limit));
}

export function insertMention(text: string, caret: number, id: string): { text: string; caret: number } {
  const query = mentionQuery(text, caret);
  if (query === null) return { text, caret };
  const start = caret - query.length - 1;
  const suffix = text.slice(caret).replace(/^[A-Za-z0-9-]*/, '');
  const insertion = `@${id} `;
  return { text: text.slice(0, start) + insertion + suffix, caret: start + insertion.length };
}

export function targetsOf(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(/(?:^|\s)@(RQ-[A-Z0-9-]+)(?![A-Za-z0-9-])/g), match => match[1]!))];
}
