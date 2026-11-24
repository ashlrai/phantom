import { describe, expect, it } from 'vitest';
import {
  RECORDED_ISSUE_CLASSIFICATION_PROVENANCE,
  RECORDED_JOB_KINDS,
  classifyRecordedIssue,
  classifyRecordedIssues,
  type RecordedBand,
  type RecordedIssueEntry,
} from '../src/core/providers/coding-cli/recorded-issue-classification.js';

function entry(over: { number?: number; title?: string; body?: string; labels?: string[]; complexity?: RecordedBand; risk?: RecordedBand } = {}): RecordedIssueEntry {
  return {
    issue: { number: over.number ?? 1, title: over.title ?? 'Add widget', body: over.body ?? 'Small change.', labels: over.labels ?? [] },
    shape: { complexity: over.complexity ?? 'medium', risk: over.risk ?? 'medium' },
  };
}

describe('recorded issue classification (recovered from PR #5952)', () => {
  it('uses the source enum spellings', () => {
    expect([...RECORDED_JOB_KINDS]).toEqual(['coding', 'investigation', 'test-fixing', 'research', 'orchestration', 'review', 'merge-decision']);
  });

  it('maps all seven kinds from labels to their roles', () => {
    const roles: Record<string, string> = {
      coding: 'produce', investigation: 'produce', 'test-fixing': 'produce', research: 'produce',
      orchestration: 'orchestration', review: 'review', 'merge-decision': 'merge',
    };
    for (const kind of RECORDED_JOB_KINDS) {
      const out = classifyRecordedIssue(entry({ labels: [`kind:${kind}`] }));
      expect(out.jobType).toBe(kind);
      expect(out.role).toBe(roles[kind]);
    }
  });

  it('first valid kind label wins over conflicting text and later labels', () => {
    const out = classifyRecordedIssue(entry({ title: 'Merge it', labels: ['bug', 'kind:research', 'kind:review'] }));
    expect(out.jobType).toBe('research');
  });

  it('invalid kind labels fall through to the next label, then text', () => {
    expect(classifyRecordedIssue(entry({ labels: ['kind:nope', 'kind:review'] })).jobType).toBe('review');
    expect(classifyRecordedIssue(entry({ labels: ['kind:', 'KIND:review', 'kind: review'], title: 'Research it' })).jobType).toBe('research');
  });

  it('applies the textual precedence order', () => {
    const cases: Array<[string, string]> = [
      ['merge review investigate test research orchestrate', 'merge-decision'],
      ['review investigate test research orchestrate', 'review'],
      ['investigation test research orchestrate', 'investigation'],
      ['failing tests research orchestrate', 'test-fixing'],
      ['CI is red, research orchestrate', 'test-fixing'],
      ['research orchestrate', 'research'],
      ['orchestration plan', 'orchestration'],
      ['plain change', 'coding'],
    ];
    for (const [title, kind] of cases) expect(classifyRecordedIssue(entry({ title })).jobType).toBe(kind);
  });

  it('matches text on title and body with word boundaries', () => {
    expect(classifyRecordedIssue(entry({ title: 'x', body: 'please review' })).jobType).toBe('review');
    expect(classifyRecordedIssue(entry({ title: 'emerge', body: 'contest' })).jobType).toBe('coding');
  });

  it('derives the tier floor from kind and shape', () => {
    const tier = (c: RecordedBand, r: RecordedBand, labels: string[] = []) => classifyRecordedIssue(entry({ complexity: c, risk: r, labels })).minTier;
    expect(tier('low', 'low')).toBe('cheap');
    expect(tier('high', 'low')).toBe('frontier');
    expect(tier('low', 'high')).toBe('frontier');
    expect(tier('medium', 'medium')).toBe('workhorse');
    expect(tier('low', 'medium')).toBe('workhorse');
    expect(tier('medium', 'low')).toBe('workhorse');
    expect(tier('low', 'low', ['kind:merge-decision'])).toBe('frontier');
    expect(tier('low', 'low', ['kind:review'])).toBe('cheap');
  });

  it('keeps recorded order and issue ids, including duplicates', () => {
    const res = classifyRecordedIssues([entry({ number: 42 }), entry({ number: 7, labels: ['kind:review'] }), entry({ number: 42 })]);
    expect(res.jobs.map((j) => j.id)).toEqual(['issue-42', 'issue-7', 'issue-42']);
    expect(classifyRecordedIssues([]).jobs).toEqual([]);
  });

  it('refuses missing or bad shapes and malformed issues with path-only errors', () => {
    const secret = 'SYNTHETIC-TITLE-TEXT';
    const bad: Array<[unknown, string]> = [
      [{ issue: entry({ title: secret }).issue }, 'entries[0].shape'],
      [{ issue: entry({ title: secret }).issue, shape: { complexity: 'low' } }, 'entries[0].shape.risk'],
      [{ issue: entry({ title: secret }).issue, shape: { complexity: 'huge', risk: 'low' } }, 'entries[0].shape.complexity'],
      [{ issue: { ...entry().issue, number: 0, title: secret }, shape: entry().shape }, 'entries[0].issue.number'],
      [{ issue: { ...entry().issue, number: 1.5 }, shape: entry().shape }, 'entries[0].issue.number'],
      [{ issue: { ...entry().issue, title: 5 }, shape: entry().shape }, 'entries[0].issue.title'],
      [{ issue: { ...entry().issue, body: null }, shape: entry().shape }, 'entries[0].issue.body'],
      [{ issue: { ...entry().issue, labels: 'kind:review' }, shape: entry().shape }, 'entries[0].issue.labels'],
      [{ issue: { ...entry().issue, labels: ['ok', 3] }, shape: entry().shape }, 'entries[0].issue.labels[1]'],
      [{ shape: entry().shape }, 'entries[0].issue'],
      [null, 'entries[0]'],
    ];
    for (const [value, path] of bad) {
      let message = '';
      try { classifyRecordedIssues([value as RecordedIssueEntry]); } catch (e) { message = (e as Error).message; }
      expect(message).toContain(path);
      expect(message).not.toContain(secret);
    }
    expect(() => classifyRecordedIssues('x' as never)).toThrow('entries must be an array');
    expect(() => classifyRecordedIssues([entry(), {} as RecordedIssueEntry])).toThrow('entries[1].issue');
  });

  it('does not mutate inputs', () => {
    const entries = [entry({ labels: ['kind:review'] })];
    const snapshot = JSON.stringify(entries);
    const frozen = Object.freeze(entries.map((e) => Object.freeze({ issue: Object.freeze({ ...e.issue, labels: Object.freeze([...e.issue.labels]) }), shape: Object.freeze({ ...e.shape }) })));
    classifyRecordedIssues(frozen);
    expect(JSON.stringify(entries)).toBe(snapshot);
  });

  it('carries provenance, grants no merge authority, and is immutable', () => {
    const res = classifyRecordedIssues([entry({ labels: ['kind:merge-decision'] })]);
    expect(res.grantsMergeAuthority).toBe(false);
    expect(res.jobs[0]!.role).toBe('merge');
    expect(res.provenance).toEqual(RECORDED_ISSUE_CLASSIFICATION_PROVENANCE);
    expect(res.provenance.sourcePr).toBe(5952);
    expect(res.provenance.sourceSha).toBe('3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886');
    expect(res.provenance.basis).toBe('historical-offline');
    expect(Object.isFrozen(res)).toBe(true);
    expect(Object.isFrozen(res.jobs)).toBe(true);
    expect(Object.isFrozen(res.jobs[0])).toBe(true);
    expect(Object.isFrozen(res.provenance)).toBe(true);
  });
});
