import { describe, expect, it } from 'vitest';
import { parseWorkTrace, workStateChip } from './work-trace-model.js';

const response = (state: string, extra: Record<string, unknown> = {}) => ({
  v: 1, authority: 'none', generatedAt: 'now', items: [{ id: 'fake', state, asOf: 'then', source: 'fake',
    missing: ['receipt'], owner: 'fake-owner', claimReceipt: 'fake-claim', inbox: 'found', claims: 'available', ...extra }],
});
const chip = (state: string, extra: Record<string, unknown> = {}) => workStateChip(parseWorkTrace(response(state, extra))?.items[0]);

describe('desktop work trace proof', () => {
  it('shows a blocked dependency alongside existing evidence', () => {
    const result = chip('BLOCKED', { result: { kind: 'blocked', dependency: 'waiting for fake job' } });
    expect(result.label).toBe('BLOCKED');
    for (const text of ['dependency: waiting for fake job', 'as of then', 'owner fake-owner', 'claim fake-claim', 'missing: receipt']) expect(result.title).toContain(text);
  });
  it('preserves all verified proof, including long text', () => {
    const long = 'fake proof '.repeat(100);
    const result = chip('VERIFIED', { result: { kind: 'verified', pr: 42, head: 'abc123', tests: long, artifact: long } });
    expect(result.label).toBe('VERIFIED');
    for (const text of ['PR: #42', 'head: abc123', `tests: ${long}`, `artifact: ${long}`]) expect(result.title).toContain(text);
  });
  it('accepts null proof fields and legacy responses without inventing evidence', () => {
    const title = chip('VERIFIED', { result: { kind: 'verified', pr: null, head: null, tests: null, artifact: null } }).title;
    expect(title).toBe(chip('VERIFIED').title);
    expect(chip('BLOCKED').title).not.toContain('dependency:');
  });
  it('rejects malformed nested results', () => {
    for (const result of [null, {}, { kind: 'blocked', dependency: {} },
      { kind: 'verified', pr: '42', head: null, tests: null, artifact: null },
      { kind: 'verified', pr: 42, head: null, tests: [], artifact: null },
      { kind: 'verified', pr: 42, head: null, tests: null }]) {
      expect(parseWorkTrace(response('VERIFIED', { result }))).toBeNull();
    }
  });
  it('does not attach proof to a mismatched state', () => {
    expect(chip('VERIFIED', { result: { kind: 'blocked', dependency: 'fake dependency' } }).title).not.toContain('fake dependency');
    expect(chip('BLOCKED', { result: { kind: 'verified', pr: 42, head: 'fake head', tests: null, artifact: null } }).title).not.toContain('fake head');
  });
});
