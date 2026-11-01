import { expect, it } from 'vitest';
import { readOutcomes } from './fleet-outcomes-model.js';
import { reissueRequest, reissueText } from './reissue-action.js';
const row = readOutcomes({ v: 1, state: 'current', feedback: { cases: [{ caseId: 'RQ-PHX-EXAMPLE31', endedAt: '2026-11-01T00:00:00Z', outcome: 'failed', lane: 'devin' }] } })!.cases[0]!;
it('builds the eligible request and rejects running or published rows', () => {
  expect(reissueRequest(row)).toEqual({ path: '/api/verse/outcomes/fleet-reissue', body: { id: row.jobId, lane: 'devin' } });
  for (const change of [{ endedAt: null }, { proposalRecorded: true }, { prLink: { url: 'https://example.com', label: 'PR' } }, { jobId: null }]) expect(reissueRequest({ ...row, ...change })).toBeNull();
});
it('formats success and refusal', () => {
  expect(reissueText({ outcome: 'written', newId: 'EXAMPLE31R1' })).toBe('re-issued as RQ-PHX-EXAMPLE31R1');
  expect(reissueText({ outcome: 'refused', reason: 'Prompt missing' })).toBe('Prompt missing');
});
