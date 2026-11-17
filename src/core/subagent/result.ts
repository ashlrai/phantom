import { readSubagentRecord, writeSubagentRecord, type SubagentOptions } from './spawn.js';

export async function readSubagentResult(id: string, options: SubagentOptions = {}) {
  const record = await readSubagentRecord(id, options);
  return { schema: 'subagent.result.v1' as const, id, found: record !== null, state: record?.state ?? null,
    result_ref: record?.result_ref ?? null, lane: record?.lane ?? null, depth: record?.depth ?? null, reason_codes: record?.reason_codes ?? [] };
}

export async function recordSubagentResult(id: string, input: { state: 'completed' | 'failed'; result_ref: string }, options: SubagentOptions = {}) {
  const record = await readSubagentRecord(id, options);
  const reason = !record ? 'not-found' : !['running', 'held'].includes(record.state) ? 'state-transition-invalid'
    : !['completed', 'failed'].includes(input.state) || !/^(run|pr|proposal|job|artifact):[A-Za-z0-9._:/#-]{1,200}$/.test(input.result_ref) ? 'result-ref-invalid' : null;
  if (reason || !record) return { ok: false, reason };
  await writeSubagentRecord({ ...record, ...input }, options);
  return { ok: true, reason: null };
}
