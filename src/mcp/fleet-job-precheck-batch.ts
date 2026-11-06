/** Inline MCP adapter over the shared batch precheck; no caller paths or writes. */
import { precheckJobBatch, JOB_PRECHECK_BATCH_MAX } from '../core/fleet/job-precheck-batch.js';
import { validJobId } from '../core/fleet/job-path-history.js';
import type { JobPrecheckGit } from '../core/fleet/job-precheck.js';
import { gitJobProbe, resolveJobPrecheckRef } from '../cli/fleet-job-precheck.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { FLEET_JOB_PRECHECK_REF, MAX_FLEET_JOB_PRECHECK_BYTES } from './fleet-job-precheck.js';

export const FLEET_BATCH_LABEL_PATTERN = '^[A-Za-z0-9_-]{1,64}$';
const LABEL = new RegExp(FLEET_BATCH_LABEL_PATTERN);
export interface FleetJobPrecheckBatchArgs {
  drafts: Array<{ label: string; markdown: string; jobId?: string }>;
}
export interface FleetJobPrecheckBatchDeps {
  resolveRef?: (ref: string) => Promise<string>;
  gitJobProbe?: (resolvedRef: string) => JobPrecheckGit;
}

export function parseFleetJobPrecheckBatchArgs(args: Record<string, unknown>): FleetJobPrecheckBatchArgs | null {
  if (Object.keys(args).some(key => key !== 'drafts') || !Array.isArray(args['drafts']) ||
      args['drafts'].length < 1 || args['drafts'].length > JOB_PRECHECK_BATCH_MAX) return null;
  const drafts: FleetJobPrecheckBatchArgs['drafts'] = [];
  const labels = new Set<string>();
  for (const item of args['drafts'] as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const draft = item as Record<string, unknown>;
    if (Object.keys(draft).some(key => key !== 'label' && key !== 'markdown' && key !== 'jobId') ||
        typeof draft['label'] !== 'string' || !LABEL.test(draft['label']) || labels.has(draft['label']) ||
        typeof draft['markdown'] !== 'string' || !draft['markdown'].trim() ||
        Buffer.byteLength(draft['markdown'], 'utf8') > MAX_FLEET_JOB_PRECHECK_BYTES ||
        ('jobId' in draft && (typeof draft['jobId'] !== 'string' || !validJobId(draft['jobId'])))) return null;
    labels.add(draft['label']);
    drafts.push({ label: draft['label'], markdown: draft['markdown'],
      ...(typeof draft['jobId'] === 'string' ? { jobId: draft['jobId'] } : {}) });
  }
  return { drafts };
}

export async function readFleetJobPrecheckBatch(input: FleetJobPrecheckBatchArgs, deps: FleetJobPrecheckBatchDeps = {}): Promise<unknown> {
  if (!parseFleetJobPrecheckBatchArgs(input as unknown as Record<string, unknown>)) throw new Error('invalid batch request');
  const resolvedRef = await (deps.resolveRef ?? resolveJobPrecheckRef)(FLEET_JOB_PRECHECK_REF);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(resolvedRef)) throw new Error('invalid resolved commit');
  const drafts = new Map(input.drafts.map(draft => [draft.label, draft]));
  const result = await precheckJobBatch(input.drafts.map(draft => draft.label), {
    readFile: async label => drafts.get(label)!.markdown,
    jobIdForFile: label => drafts.get(label)?.jobId,
    git: (deps.gitJobProbe ?? gitJobProbe)(resolvedRef),
  });
  return sanitizePublicJson({
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    note: 'Advisory recorded evidence only; path and commit evidence cannot prove semantic completion. Never queue, dispatch or merge authorization.',
    ref: FLEET_JOB_PRECHECK_REF, resolvedRef,
    entries: result.entries.map(({ file, report, error }) => error !== undefined
      ? { label: file, error: 'git precheck failed' } : { label: file, report }),
    counts: result.counts,
    collisions: result.collisions.map(({ path, files }) => ({ path, labels: files })),
  });
}
