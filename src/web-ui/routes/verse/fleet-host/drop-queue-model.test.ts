import { describe, expect, it } from 'vitest';
import { dropQueueCard } from './drop-queue-model.js';

const job = (id: string, ageSeconds: number) => ({ id, ageSeconds, lane: 'codex', tier: 'mid', title: 'Example job', bytes: 42 });
const card = (items: unknown[]) => dropQueueCard({ v: 1, items }, 0);

describe('dropQueueCard', () => {
  it('describes an empty folder', () => {
    expect(card([])).toEqual({ headline: 'Drop folder empty', tone: 'ok', verdict: 'The ingest sweeps it about every 2 minutes.', rows: [] });
  });
  it('describes waiting jobs and formats ages', () => {
    expect(card([job('A', 45), job('B', 180)])).toEqual({
      headline: '2 jobs waiting for ingest · oldest 3 min', tone: 'ok', verdict: null,
      rows: [{ id: 'B', laneTier: 'codex/mid', title: 'Example job', age: '3 min' }, { id: 'A', laneTier: 'codex/mid', title: 'Example job', age: '45 s' }],
    });
    expect(card([job('C', 5400)])?.rows[0]?.age).toBe('1.5 h');
  });
  it('warns at exactly ten minutes', () => {
    expect(card([job('A', 599)])?.tone).toBe('ok');
    expect(card([job('A', 600)])).toMatchObject({ headline: '1 job waiting for ingest · oldest 10 min', tone: 'warn', verdict: 'Ingest looks stuck: the oldest file has waited 10 min. Check orch-ingest on this Mac.' });
  });
  it('handles missing metadata', () => {
    expect(card([{ ...job('A', 1), lane: null, tier: null, title: null }])?.rows).toEqual([{ id: 'A', laneTier: '—', title: '(untitled)', age: '1 s' }]);
    expect(card([{ ...job('A', 1), tier: null }])?.rows[0]?.laneTier).toBe('—');
  });
  it('shows at most eight oldest jobs, without changing the count', () => {
    const jobs = Array.from({ length: 10 }, (_, i) => job(String(i), i));
    const result = card(jobs);
    expect(result?.headline).toBe('10 jobs waiting for ingest · oldest 9 s');
    expect(result?.rows.map((row) => row.id)).toEqual(['9', '8', '7', '6', '5', '4', '3', '2']);
    expect(jobs[0]?.id).toBe('0');
  });
  it('rejects malformed or unsupported responses', () => {
    for (const value of [null, {}, { v: 2, items: [] }, { v: 1, items: null }, { v: 1, items: [{}] }, { v: 1, items: [{ ...job('A', -1) }] }, { v: 1, items: [{ ...job('A', NaN) }] }]) {
      expect(dropQueueCard(value, 0)).toBeNull();
    }
  });
});
