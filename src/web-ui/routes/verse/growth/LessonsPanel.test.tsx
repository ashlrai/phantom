import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LessonsPanel } from './LessonsPanel.js';
import { causeChart, parseScopeForm, trialLine, trialSummary } from './lessons-model.js';
import { narrowLessons } from './lessons-data.js';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import type { KnowledgeNoteV1, LessonsStateV1 } from '../../../../core/learn/retro/types.js';

const NOW = '2026-09-27T12:00:00.000Z';

function note(id: string, text: string, status: KnowledgeNoteV1['status'], over: Partial<KnowledgeNoteV1> = {}): KnowledgeNoteV1 {
  return {
    v: 1, id, text, scope: { repo: 'ashlrai/widget', pathGlobs: ['src/parser/**'], taskKinds: ['fix'] }, status, retroId: 'rt_1', source: 'fleet',
    createdAt: NOW, decidedAt: status === 'pending' ? null : NOW, edited: false, hits: 0, lastHitAt: null, seen: 1, agentsMdTaskId: null, ...over,
  };
}

function lessons(over: Partial<LessonsStateV1> = {}): LessonsStateV1 {
  return {
    v: 1,
    retros: [{
      id: 'rt_1', source: 'fleet', taskId: 'p-1', repo: 'ashlrai/widget', endKind: 'verify-failed', endedAt: NOW, taskKind: 'fix',
      asked: 'Fix flaky parser test', happened: 'Verification failed: 2 tests failed',
      rootCause: { code: 'verify:test', label: 'Tests failed', detail: '2 tests failed', evidence: 'verify output' },
      doDifferently: ['Run npm test before proposing.'], betterPrompt: 'Fix flaky parser test\n\nConstraints learned from the last attempt:\n- Run npm test.',
      candidates: 1, modelAssisted: false,
    }],
    endKinds: { 'verify-failed': 1 },
    causes: [{ code: 'verify:test', label: 'Tests failed', count: 3, bySource: { fleet: 2, cloud: 1, leader: 0 } }],
    windowDays: 30,
    knowledge: {
      pending: [note('kn_0000000000000001', 'Run npm test in widget before proposing parser fixes.', 'pending', { seen: 3 })],
      approved: [note('kn_0000000000000002', 'Widget parser PRs stay under 400 lines.', 'approved', {
        hits: 7,
        trial: { served: { tasks: 8, landed: 7, rate: 0.875 }, holdout: { tasks: 3, landed: 1, rate: 1 / 3 }, delta: 0.875 - 1 / 3, ci95: [0.1, 0.9], verdict: 'helps' },
      })],
      rejected: 0,
      approvedBytes: 40,
      capBytes: 16384,
      trial: {
        holdout: 0.2,
        overall: { scope: 'all', served: { tasks: 8, landed: 7, rate: 0.875 }, holdout: { tasks: 3, landed: 1, rate: 1 / 3 }, delta: 0.5, ci95: [0.05, 0.95], verdict: 'helps' },
        excluded: { launchFailed: 1, unfinished: 2 },
      },
    },
    playbook: [{ text: 'Mason vetoed the Leader\'s "Open 4 Grok lanes" (lane.set).', hits: 1, addedAt: NOW }],
    sweptAt: NOW,
    ...over,
  };
}

beforeEach(() => {
  evictAll();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearMutationToken();
});

describe('LessonsPanel', () => {
  it('shows recurring causes, recent retros, suggestions and approved knowledge with hits', async () => {
    stubSurfaceFetch({ routes: { '/api/verse/learning/lessons': lessons() } });
    render(<LessonsPanel />);
    await screen.findByRole('figure', { name: 'Recurring failure causes · 30d' });
    expect(await screen.findByText('Run npm test in widget before proposing parser fixes.')).toBeInTheDocument();
    expect(screen.getByText(/suggested 3×/)).toBeInTheDocument();
    expect(screen.getByText('Widget parser PRs stay under 400 lines.')).toBeInTheDocument();
    expect(screen.getByText(/used 7×/)).toBeInTheDocument();
    expect(screen.getByText(/Leader veto lesson/)).toBeInTheDocument();
    // The holdout trial's causal read shows per note and for the whole queue.
    expect(screen.getByText(/lesson trial served 7\/8 landed · holdout 1\/3 landed · \+54 pts \(helps\)/)).toBeInTheDocument();
    expect(screen.getByText(/20% of launches held out · 2 unfinished, 1 launch failure not counted/)).toBeInTheDocument();
    // A retro expands to its cause, next steps and better prompt.
    fireEvent.click(screen.getByRole('button', { name: /Fix flaky parser test/ }));
    expect(screen.getByText('Tests failed', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('Run npm test before proposing.')).toBeInTheDocument();
    expect(screen.getByText(/Constraints learned from the last attempt/)).toBeInTheDocument();
  });

  it('approve posts the decision with the held token', async () => {
    setMutationToken('a'.repeat(64));
    const stub = stubSurfaceFetch({ routes: { '/api/verse/learning/lessons': lessons() } });
    render(<LessonsPanel />);
    const text = await screen.findByText('Run npm test in widget before proposing parser fixes.');
    const row = text.closest('li')!;
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(stub.posted).toEqual([{ url: '/api/verse/learning/lessons/knowledge', body: { id: 'kn_0000000000000001', decision: 'approve' } }]));
  });

  it('edit then approve sends the edited text and scope', async () => {
    setMutationToken('b'.repeat(64));
    const stub = stubSurfaceFetch({ routes: { '/api/verse/learning/lessons': lessons() } });
    render(<LessonsPanel />);
    const row = (await screen.findByText('Run npm test in widget before proposing parser fixes.')).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(row).getByLabelText('Lesson'), { target: { value: 'Always run npm test in widget.' } });
    fireEvent.change(within(row).getByLabelText('Task kinds'), { target: { value: '' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Approve edited' }));
    await waitFor(() => expect(stub.posted[0]?.body).toEqual({
      id: 'kn_0000000000000001', decision: 'approve', text: 'Always run npm test in widget.',
      scope: { repo: 'ashlrai/widget', pathGlobs: ['src/parser/**'], taskKinds: [] },
    }));
  });

  it('an older server without the route says so instead of breaking Growth', async () => {
    stubSurfaceFetch({ routes: { '/api/verse/learning/lessons': null } });
    render(<LessonsPanel />);
    expect((await screen.findAllByText(/Lessons is not in this build yet/)).length).toBeGreaterThan(0);
  });
});

describe('lessons model', () => {
  it('causeChart stacks by source; parseScopeForm validates', () => {
    expect(causeChart(lessons().causes)).toEqual({ categories: ['Tests failed'], values: [[2, 1, 0]] });
    expect(parseScopeForm('', 'src/**, docs/*.md', 'fix, tests')).toEqual({ repo: null, pathGlobs: ['src/**', 'docs/*.md'], taskKinds: ['fix', 'tests'] });
    expect(parseScopeForm('not a repo', '', '')).toBeNull();
    expect(parseScopeForm('a/b', '../x', '')).toBeNull();
    expect(parseScopeForm('a/b', '', 'nonsense')).toBeNull();
    expect(narrowLessons({ v: 1 })).toBeNull();
    expect(narrowLessons(lessons())).not.toBeNull();
  });

  it('trialLine shows arm counts always and the verdict only once measured', () => {
    const measured = { served: { tasks: 5, landed: 4, rate: 0.8 }, holdout: { tasks: 4, landed: 1, rate: 0.25 }, delta: 0.55, ci95: [0.05, 0.9] as [number, number], verdict: 'helps' as const };
    expect(trialLine(measured)).toBe('lesson trial served 4/5 landed · holdout 1/4 landed · +55 pts (helps)');
    const measuring = { served: { tasks: 2, landed: 2, rate: 1 }, holdout: { tasks: 1, landed: 0, rate: 0 }, delta: null, ci95: null, verdict: 'unknown' as const };
    expect(trialLine(measuring)).toBe('lesson trial served 2/2 landed · holdout 0/1 landed — measuring');
    const summary = lessons().knowledge.trial!;
    expect(trialSummary(summary)).toContain('50 pts (helps)');
    expect(trialSummary(summary)).toContain('20% of launches held out');
    expect(trialSummary(summary)).toContain('not counted');
  });
});
