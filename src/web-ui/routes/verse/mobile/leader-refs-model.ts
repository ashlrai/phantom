import { pullUrl, splitRefs } from '../fleet/job-refs.js';

export function leaderRefs(text: string): { jobs: string[]; prs: number[] } {
  const jobs = new Set<string>();
  const prs = new Set<number>();
  for (const ref of splitRefs(text)) {
    if (ref.kind === 'job' && jobs.size < 8) jobs.add(ref.value);
    if (ref.kind === 'pr' && ref.number !== undefined && ref.value.length <= 7 && ref.number <= 999999 && prs.size < 8) {
      prs.add(ref.number);
    }
  }
  return { jobs: [...jobs], prs: [...prs] };
}

export function prHref(number: number): string | null {
  return pullUrl('ashlrai/phantom', number);
}
