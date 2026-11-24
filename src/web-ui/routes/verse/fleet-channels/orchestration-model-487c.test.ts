import { expect, it } from 'vitest';
import { toOrchestrationView } from './orchestration-model.js';

// Basic test to validate the functions work according to the requirements
it('Test valid payload functionality', () => {
  const validPayload = {
    schemaVersion: 1,
    authority: 'none',
    source: 'ok',
    total: 1,
    truncated: false,
    counts: { reserved: 1, admitted: 0, complete: 0 },
    unresolved: [],
    receipts: [{ job: 'RQ-FAKE-1', specialist: 'reviewer', assignedAt: '2026-11-16T12:00:00.000Z', status: 'reserved' }]
  };

  const view = toOrchestrationView(validPayload);

  // Test 1: A valid payload gives header "1 reserved · 0 admitted · 0 complete" and one row
  expect(view).not.toBeNull();
  expect(view!.header).toBe('1 reserved · 0 admitted · 0 complete');
  expect(view!.rows).toHaveLength(1);

  // Test 2: source "missing" gives the header "No orchestration journal yet"
  const viewMissing = toOrchestrationView({
    ...validPayload,
    source: 'missing'
  });
  expect(viewMissing).not.toBeNull();
  expect(viewMissing!.header).toBe('No orchestration journal yet');

  // Test 3: Returns null when authority is anything other than "none", when schemaVersion is 2, or when a count is negative or fractional
  expect(toOrchestrationView({
    ...validPayload,
    authority: 'admin'
  })).toBeNull();

  expect(toOrchestrationView({
    ...validPayload,
    schemaVersion: 2
  })).toBeNull();

  expect(toOrchestrationView({
    ...validPayload,
    counts: { reserved: -1, admitted: 0, complete: 0 }
  })).toBeNull();

  expect(toOrchestrationView({
    ...validPayload,
    counts: { reserved: 1.5, admitted: 0, complete: 0 }
  })).toBeNull();
});
