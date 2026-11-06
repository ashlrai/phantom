import type { FleetRunsMerge } from './runs-queries.js';

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

export function prUrl(merge: FleetRunsMerge): string | null {
  return REPO.exec(merge.repo)?.[0] === merge.repo && Number.isSafeInteger(merge.number) && merge.number > 0
    ? `https://github.com/${merge.repo}/pull/${merge.number}` : null;
}

export function mergeLabel(merge: FleetRunsMerge): string {
  return `#${merge.number} · ${merge.title}`;
}
