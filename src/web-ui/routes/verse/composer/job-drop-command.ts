import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiPost, readFailureReason } from '../../../data/client.js';
import { VerseMutationLockedError } from '../verse-queries.js';

const LANES = ['claude', 'codex-personal', 'devin', 'codex-local'];
const TIERS = ['frontier', 'work', 'mid', 'fast'];
// Mirrors drop-job-writer.ts; tested against the core source without bundling Node APIs.
export const DENIED_TOKENS = ['.github/', '/.codex', 'auth.json', 'CODEOWNERS'] as const;
const USAGE = 'Use /job [lane=…] [tier=…] <what to build>';

export function parseJobCommand(draft: string): { lane: string; tier: string; text: string } | { error: string } | null {
  if (!/^\/job(?=\s|$)/.test(draft)) return null;
  let text = draft.slice(4).trim();
  let lane = 'codex-personal';
  let tier = 'mid';
  for (;;) {
    const option = /^(lane|tier)=(\S*)(?:\s+|$)/.exec(text);
    if (!option) break;
    const value = option[2]!;
    const allowed = option[1] === 'lane' ? LANES : TIERS;
    if (!allowed.includes(value)) return { error: `Unknown ${option[1]}; allowed values: ${allowed.join(', ')}` };
    if (option[1] === 'lane') lane = value;
    else tier = value;
    text = text.slice(option[0].length).trim();
  }
  if (!text) return { error: USAGE };
  if (new TextEncoder().encode(text).length > 6000) return { error: 'Job text must be at most 6000 bytes' };
  if (DENIED_TOKENS.some(token => text.includes(token))) return { error: 'the fleet ingest rejects that path' };
  return { lane, tier, text };
}

export function jobIdFor(text: string, now: number): string {
  return `MASON${text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20)}${now.toString(36).toUpperCase()}`;
}

export function buildJobBody(text: string, at: string): string {
  return `Goal (Mason, Phantom desktop composer, ${at}): ${text}\n\nLeave changes uncommitted. Write BRIDGE_NOTES.md with what changed and verification results. Name at least one new test file in BRIDGE_NOTES.md.\n`;
}

export async function runJobCommand(draft: string): Promise<{ ok: boolean; text: string }> {
  const command = parseJobCommand(draft);
  if (!command) return { ok: false, text: USAGE };
  if ('error' in command) return { ok: false, text: command.error };
  try {
    const token = getMutationToken();
    if (!token) throw new VerseMutationLockedError();
    const now = Date.now();
    const id = jobIdFor(command.text, now);
    const body = buildJobBody(command.text, new Date(now).toISOString());
    const result = await apiPost<{ bytes: number }>('/api/verse/fleet/live/drop-jobs', { id, lane: command.lane, tier: command.tier, body }, token);
    touchMutationHold();
    return { ok: true, text: `Dropped job RQ-PHX-${id} for ${command.lane}/${command.tier} · ${result.bytes} bytes` };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 404) return { ok: false, text: 'Drop-jobs API is not in this build' };
      if (error.status === 409) return { ok: false, text: 'That job id already exists' };
      if (error.status === 503 || error.status === 507) return { ok: false, text: 'Prompt queue is full (40); wait for ingest' };
    }
    return { ok: false, text: error instanceof VerseMutationLockedError ? error.message : readFailureReason(error) };
  }
}
