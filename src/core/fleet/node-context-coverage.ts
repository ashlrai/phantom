/** Derive upstream coverage summary from a NodeContextPack. */

import type { NodeContextPackInput } from './node-context-pack.js';

/** Coverage state for a single upstream job. */
export type UpstreamCoverage = {
  jobId: string;
  /** How well-pack context covers this upstream's output. */
  state: 'missing-output' | 'omitted' | 'truncated' | 'included';
};

/** Parsed JSONL entry from a node-context pack. */
interface JsonObject {
  jobId?: unknown;
  kind?: unknown;
  text?: unknown;
  truncated?: unknown;
}

/** A valid parsed output entry from the pack. */
interface OutputEntry {
  jobId: string;
  text: string;
  truncated: boolean;
}

/** Summarise which upstream outputs are covered in the supplied pack.

 * @param input  The original `NodeContextPackInput` (type-only).
 * @param pack   A `buildNodeContextPack` JSONL string to analyse.
 * @returns Distinct upstream coverage grouped by jobId (first-occurrence order).
 */
export function summarizeNodeContextCoverage(
  _input: NodeContextPackInput,
  pack: string,
): { upstream: UpstreamCoverage[] } {
  const { node } = _input;
  /* Build a lookup: jobId → { hasNonBlank: boolean }. */
  const outputMap = new Map<string, { hasNonBlank: boolean }>();
  for (const o of _input.outputs) {
    const key = o.jobId;
    const cur = outputMap.get(key);
    if (cur) {
      cur.hasNonBlank = cur.hasNonBlank || !!o.text.trim();
    } else {
      outputMap.set(key, { hasNonBlank: !!o.text.trim() });
    }
  }

  /* Parse the pack JSONL and collect entries per jobId. */
  const entriesByJob = new Map<string, OutputEntry[]>();
  for (const rawLine of pack.trimEnd().split('\n')) {
    if (!rawLine) continue;
    let obj: JsonObject;
    try { obj = JSON.parse(rawLine); } catch { continue; }
    /* Only accept well-formed output entries. */
    if (
      typeof obj.jobId !== 'string' ||
      obj.kind !== 'output' ||
      typeof obj.text !== 'string' ||
      typeof obj.truncated !== 'boolean'
    ) {
      continue;
    }
    const list = entriesByJob.get(obj.jobId) ?? [];
    list.push({ jobId: obj.jobId, text: obj.text, truncated: obj.truncated });
    entriesByJob.set(obj.jobId, list);
  }

  /* For each distinct upstream jobId (first-occurrence order). */
  const seen = new Set<string>();
  const upstream: UpstreamCoverage[] = [];

  for (const jobId of node.upstreamJobIds) {
    if (seen.has(jobId)) continue;
    if (jobId === node.jobId) continue;
    seen.add(jobId);

    const hasNonBlank = outputMap.get(jobId)?.hasNonBlank ?? false;
    const entries = entriesByJob.get(jobId);

    let state: UpstreamCoverage['state'];
    if (!hasNonBlank) {
      /* The caller never provided nonblank output text for this job. */
      state = 'missing-output';
    } else if (!entries) {
      /* Nonblank output exists but no output entry appeared in the pack. */
      state = 'omitted';
    } else {
      /* Output entries exist in the pack. */
      state = entries.every(e => e.truncated) ? 'truncated' : 'included';
    }

    upstream.push({ jobId, state });
  }

  return { upstream };
}
