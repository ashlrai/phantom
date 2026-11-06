import { splitRefs } from '../fleet/job-refs.js';

/** Collect only references that can be rendered by JobRefs. */
export function threadRefs(text: string): { jobs: string[]; prs: number[] } {
  const jobs = new Set<string>();
  const prs = new Set<number>();
  for (const segment of splitRefs(text)) {
    if (segment.kind === 'job' && jobs.size < 12) jobs.add(segment.value);
  }
  for (const match of text.matchAll(/(?<![A-Za-z0-9_#])#\d+(?![A-Za-z0-9_]|\.\d)/g)) {
    const number = Number(match[0].slice(1));
    if (number >= 1 && number <= 999999 && prs.size < 12) prs.add(number);
  }
  return { jobs: [...jobs], prs: [...prs] };
}

export function hasThreadRefs(text: string): boolean {
  const { jobs, prs } = threadRefs(text);
  return jobs.length > 0 || prs.length > 0;
}
