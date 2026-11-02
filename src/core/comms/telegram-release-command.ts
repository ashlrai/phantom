import { DROP_JOB_LANES } from '../fleet/drop-job-writer.js';

const LANES = new Set<string>([...DROP_JOB_LANES, 'codex-cmp', 'claude-api']);

export function parseReleaseCommand(text: string): { lane: string } | null {
  const match = /^\s*\/release(?:@\w+)?\s+([a-z0-9-]{3,40})\s*$/i.exec(text);
  const lane = match?.[1];
  return lane && /^[a-z0-9-]{3,40}$/.test(lane) && LANES.has(lane) ? { lane } : null;
}

export type ReleaseReply =
  | { status: 'released'; lane: string; target?: number }
  | { status: 'not-held'; lane: string }
  | { status: 'failed'; reason: 'manual-hold' | 'unknown-lane' | 'unavailable' };

/** Only fixed failure messages are exposed; filesystem and provider errors may contain secrets. */
export function renderReleaseReply(result: ReleaseReply): string {
  if (result.status === 'not-held') return `${result.lane} is not held.`;
  if (result.status === 'released') return `${result.lane} released.${result.target === undefined ? '' : ` Target ${result.target}.`}`;
  const reason = { 'manual-hold': 'lane was held manually', 'unknown-lane': 'lane is unavailable', unavailable: 'lane holds unavailable' }[result.reason];
  return `Release failed: ${reason}.`;
}
