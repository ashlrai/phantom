import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import type { OpsSelfUpdateV1 } from './ops-types.js';
import type { SelfUpdateApplyResult, SelfUpdateRestartMode } from './self-update-apply.js';

export interface SelfUpdateLastApply {
  outcome: SelfUpdateApplyResult['outcome'];
  reason: string | null;
  startedAt: string;
  finishedAt: string;
  fromCommit: string | null;
  toCommit: string | null;
  restartRequired: boolean;
  restartMode: SelfUpdateRestartMode;
}

export interface OpsSelfUpdateWithLastApply extends OpsSelfUpdateV1 {
  lastApply: SelfUpdateLastApply | null;
}

/** Advisory history: missing, corrupt or unreadable results never block status. */
export function readSelfUpdateLastApply(path?: string): SelfUpdateLastApply | null {
  try {
    const r = JSON.parse(readFileSync(path ?? join(ashlrHome(), 'verse', 'self-update-last.json'), 'utf8'));
    const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
    const commit = (v: unknown): boolean => v === null || (typeof v === 'string' && /^[a-f0-9]{40,64}$/.test(v));
    if (!r || r.v !== 1 || !['updated', 'already-current', 'refused', 'failed'].includes(r.outcome)
      || !(r.reason === null || typeof r.reason === 'string') || !date(r.startedAt) || !date(r.finishedAt)
      || !commit(r.fromCommit) || !commit(r.toCommit) || typeof r.restart?.required !== 'boolean'
      || !['sidecar-supervised', 'manual'].includes(r.restart.mode) || !Array.isArray(r.steps)
      || !r.steps.every((s: unknown) => {
        if (!s || typeof s !== 'object') return false;
        const step = s as Record<string, unknown>;
        return ['status', 'fetch', 'ahead', 'update'].includes(step.name as string) && typeof step.ok === 'boolean'
          && typeof step.ms === 'number' && Number.isFinite(step.ms) && step.ms >= 0
          && (step.note === null || typeof step.note === 'string');
      })) return null;
    return { outcome: r.outcome, reason: r.reason, startedAt: r.startedAt, finishedAt: r.finishedAt,
      fromCommit: r.fromCommit, toCommit: r.toCommit, restartRequired: r.restart.required, restartMode: r.restart.mode };
  } catch { return null; }
}
