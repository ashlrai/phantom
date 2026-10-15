import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AutomaticDecisionReceiptV1 } from '../../../../core/routing/automatic-decision-types.js';
import { AutomaticAdviceDetails } from './AutomaticAdviceDetails.js';

function receipt(): AutomaticDecisionReceiptV1 {
  const unknown = { state: 'unknown' as const, value: null };
  const metric = { ...unknown, code: 'not-qualified-by-receipt' as const };
  return {
    schemaVersion: 1, scope: 'automatic-decision-receipt', executionAuthorized: false, status: 'recommendation',
    recommendedBinding: { seatId: 'account', engine: 'claude', model: 'literal-model', contextMode: 'expansive', contextWindow: 65_536 },
    alternatives: [], baseline: { mode: 'auto', stay: false, localOnly: false }, held: null, exclusions: [],
    intent: { phase: 'execute', phaseBasis: { kind: 'prompt-intent', declaredManagerIntent: null }, eligibilitySurface: { kind: 'interactive-chat-advice', declaredRole: null }, provenance: 'caller-declared' },
    correlation: { provenance: 'caller-declared', observedAtMs: 123, refs: { sourceRef: null, policyRef: null, rosterRef: null, sessionRef: null, preferenceRef: null, basisRef: null } },
    classification: { scope: 'task-triage-only', kind: 'code', task: 'code', difficulty: 'high', size: 'small', estTokens: 10, decidedBy: 'jev', confidence: 0.99, needsFrontier: 0.99, fallbackCode: 'not-provided' },
    returnedSessionBinding: unknown, providerObservedBinding: unknown, verifiedOutcome: unknown,
    metrics: { quality: metric, executionDurationMs: metric, realizedCostUsd: metric },
  };
}

describe('AutomaticAdviceDetails', () => {
  it('starts folded, has a keyboard focus stop and native disclosure behavior', async () => {
    render(<AutomaticAdviceDetails receipt={receipt()} accountLabels={{ account: 'Fixture account' }} />);
    const summary = screen.getByText('Automatic details');
    const details = summary.closest('details')!;
    expect(details).not.toHaveAttribute('open');
    await userEvent.setup().tab();
    expect(summary).toHaveFocus();
    await userEvent.setup().click(summary);
    expect(details).toHaveAttribute('open');
    await userEvent.setup().click(summary);
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByText('Draft recommendation · may change when you send.')).toBeInTheDocument();
    expect(screen.getByText('literal-model · expansive · 65,536 tokens context')).toBeInTheDocument();
  });
  it('preserves ordered duplicate-account alternatives without selecting one', () => {
    const r = receipt();
    r.alternatives = [
      { seatId: 'account', engine: 'claude', model: 'second-model', contextMode: 'standard', contextWindow: 100_000 },
      { seatId: 'account', engine: 'claude', model: 'third-model', contextMode: 'expansive', contextWindow: 200_000 },
    ];
    render(<AutomaticAdviceDetails receipt={r} accountLabels={{ account: 'Fixture account' }} />);
    expect(screen.getByText('literal-model · expansive · 65,536 tokens context')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { hidden: true })).getAllByRole('listitem', { hidden: true }).map((li) => li.textContent)).toEqual([
      'Fixture account · second-model · standard · 100,000 tokens context', 'Fixture account · third-model · expansive · 200,000 tokens context',
    ]);
  });
  it('distinguishes accounts with identical bindings and refuses inherited lookup labels', () => {
    const r = receipt();
    r.alternatives = [
      { ...r.recommendedBinding!, seatId: 'second-account' },
      { ...r.recommendedBinding!, seatId: 'third-account' },
      { ...r.recommendedBinding!, seatId: 'toString' },
      { ...r.recommendedBinding!, seatId: 'constructor' },
      { ...r.recommendedBinding!, seatId: '__proto__' },
    ];
    render(<AutomaticAdviceDetails receipt={r} accountLabels={{ account: 'Selected account', 'second-account': 'Work account', 'third-account': 'Personal account' }} />);
    expect(screen.getByText('Selected account')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { hidden: true })).getAllByRole('listitem', { hidden: true }).map((li) => li.textContent)).toEqual([
      'Work account · literal-model · expansive · 65,536 tokens context',
      'Personal account · literal-model · expansive · 65,536 tokens context',
      'Unknown account · literal-model · expansive · 65,536 tokens context',
      'Unknown account · literal-model · expansive · 65,536 tokens context',
      'Unknown account · literal-model · expansive · 65,536 tokens context',
    ]);
  });
  it('treats an own non-string label as unknown without rendering an object', () => {
    render(<AutomaticAdviceDetails receipt={receipt()} accountLabels={{ account: { privateClaim: 'ready' } } as unknown as Readonly<Record<string, string>>} />);
    expect(screen.getByText('Unknown account')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('privateClaim');
  });
  it('keeps null bindings unknown while preserving a zero context window', () => {
    const r = receipt();
    r.recommendedBinding = { seatId: null, engine: null, model: null, contextMode: null, contextWindow: null };
    const view = render(<AutomaticAdviceDetails receipt={r} accountLabels={{}} />);
    expect(screen.getByText('Unknown account')).toBeInTheDocument();
    expect(screen.getByText('Unknown model · Unknown context mode · Unknown context window')).toBeInTheDocument();
    r.recommendedBinding.contextWindow = 0;
    view.rerender(<AutomaticAdviceDetails receipt={r} accountLabels={{}} />);
    expect(screen.getByText('Unknown model · Unknown context mode · 0 tokens context')).toBeInTheDocument();
  });
  it('uses fixed held and unknown evidence copy instead of private claims or confidence', () => {
    const r = Object.assign(receipt(), { prompt: 'private-prompt', why: 'private-why', error: 'private-error' });
    Object.assign(r.classification, { label: 'private-label', signals: ['private-signal'] });
    r.correlation.refs.sourceRef = 'private-reference';
    r.recommendedBinding = null; r.status = 'advisory-held'; r.baseline.localOnly = true;
    render(<AutomaticAdviceDetails receipt={r} accountLabels={{}} />);
    expect(screen.getByText('No recommendation is available for this draft.')).toBeInTheDocument();
    expect(screen.getByText('Local-only project.')).toBeInTheDocument();
    expect(screen.getByText('Actual model use, results, quality, time and cost are unknown in this preview.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/private-|99%|authorized|verified successfully/);
    expect(screen.getByText('Jev')).toBeInTheDocument();
  });
  it('renders catalog labels as plain text without turning them into markup', () => {
    render(<AutomaticAdviceDetails receipt={receipt()} accountLabels={{ account: '<img src=x onerror=alert(1)>' }} />);
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});
