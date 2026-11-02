import { describe, expect, it } from 'vitest';
import type { AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';
import { jobBusMentions, mentionSummary } from './job-bus-mentions.js';

const job = 'RQ-PHX-ABC31';
const receipt = (cursor: number, body: unknown, id = `id-${cursor}`): AgentBusReceipt => ({
  cursor, receivedAt: cursor * 1_000, envelope: { id, from: 'graph-coordinator', to: 'leaders', priority: 'P1', ttl: 5_000, body },
});

describe('job bus mentions', () => {
  it('matches whole tokens throughout JSON and handles string and array bodies', () => {
    const rows = [receipt(1, { kind: 'handoff', job, text: `taking ${job}` }), receipt(2, `about ${job}!`),
      receipt(3, [{ nested: `(${job})` }]), receipt(4, `prefix ${job}0`), receipt(5, `x${job}`)];
    expect(jobBusMentions(rows, job, 10_000).map(row => row.key)).toEqual(['id-3', 'id-2', 'id-1']);
    expect(jobBusMentions([rows[0]], 'RQ-PHX-ABC3', 10_000)).toEqual([]);
    expect(jobBusMentions([rows[0]], job, 10_000)[0]).toMatchObject({ from: 'graph-coordinator', to: 'leaders', kind: 'handoff', excerpt: `taking ${job}`, expired: true });
  });

  it('accepts an exact body.job even when the job has regex characters', () => {
    expect(jobBusMentions([receipt(1, { job: 'RQ.PHX', text: 'hello' })], 'RQ.PHX', 2_000)).toHaveLength(1);
    expect(jobBusMentions([receipt(1, 'RQxPHX')], 'RQ.PHX', 2_000)).toHaveLength(0);
  });

  it('deduplicates newest first, caps rows and truncates excerpts', () => {
    const rows = [receipt(1, { text: `${job} old` }, 'same'), receipt(3, { text: `${job} ${'x'.repeat(150)}` }, 'same'),
      receipt(2, { text: job }), receipt(4, { text: 'other' })];
    const mentions = jobBusMentions(rows, job, 3_000, 1);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({ key: 'same', at: new Date(3_000).toISOString(), expired: false });
    expect(mentions[0].excerpt).toHaveLength(120);
    expect(jobBusMentions(rows, job, 3_000).map(row => row.key)).toEqual(['same', 'id-2']);
    expect(jobBusMentions(rows, job, 3_000, 0)).toEqual([]);
  });

  it('summarizes matches and the scan window', () => {
    const rows = jobBusMentions([receipt(1, job), receipt(2, job), receipt(3, job)], job, 3_000);
    expect(mentionSummary(rows, 100)).toBe('3 mentions in the last 100 bus envelopes');
    expect(mentionSummary(rows.slice(0, 1), 5)).toBe('1 mention in the last 5 bus envelopes');
    expect(mentionSummary([], 7)).toBe('No mentions in the last 7 bus envelopes');
  });
});
