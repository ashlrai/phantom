import { expect, it } from 'vitest';
import { freeLaneAlternative } from './drop-job-lane-switch.js';
import type { PreflightTargets } from './drop-job-preflight.js';

const base = { target: 4, floor: 0, ceiling: 16, held: false, heldUntil: null, heldReason: null, lastChange: null, changedBy: null };
function targets(rows: Record<string, { running?: number; held?: boolean; target?: number }>, sourceState: string = 'healthy'): PreflightTargets {
  return { v: 1, generatedAt: '', sourceState, lanes: Object.entries(rows).map(([lane, extra]) => ({ ...base, lane, ...extra })) } as PreflightTargets;
}

it('picks the unheld lane with the most free slots when the current lane is held', () => {
  const result = freeLaneAlternative('codex-personal', targets({ 'codex-personal': { held: true, running: 0 }, devin: { running: 3 }, claude: { running: 1 } }));
  expect(result).toEqual({ lane: 'claude', freeSlots: 3 });
});
it('breaks ties by lane name', () => {
  const result = freeLaneAlternative('codex-personal', targets({ 'codex-personal': { held: true }, devin: { running: 2 }, claude: { running: 2 } }));
  expect(result).toEqual({ lane: 'claude', freeSlots: 2 });
});
it('switches away from a full lane', () => {
  const result = freeLaneAlternative('codex-personal', targets({ 'codex-personal': { running: 4 }, devin: { running: 3 } }));
  expect(result).toEqual({ lane: 'devin', freeSlots: 1 });
});
it('skips held alternatives', () => {
  expect(freeLaneAlternative('codex-personal', targets({ 'codex-personal': { held: true }, devin: { running: 0, held: true } }))).toBeNull();
});
it('returns null when the current lane can start a job', () => {
  expect(freeLaneAlternative('codex-personal', targets({ 'codex-personal': { running: 1 }, devin: { running: 0 } }))).toBeNull();
});
it('returns null when the source is not healthy or targets are missing', () => {
  const rows = { 'codex-personal': { held: true }, devin: { running: 0 } };
  expect(freeLaneAlternative('codex-personal', targets(rows, 'stale'))).toBeNull();
  expect(freeLaneAlternative('codex-personal', null)).toBeNull();
  expect(freeLaneAlternative('codex-personal', undefined)).toBeNull();
});
it('ignores rows whose running count is unknown', () => {
  expect(freeLaneAlternative('codex-personal', targets({ 'codex-personal': { held: true }, devin: {}, claude: { running: 3 } }))).toEqual({ lane: 'claude', freeSlots: 1 });
  expect(freeLaneAlternative('codex-personal', targets({ 'codex-personal': { held: true }, devin: {} }))).toBeNull();
});
it('ignores lanes outside the draft lane list', () => {
  expect(freeLaneAlternative('codex-personal', targets({ 'codex-personal': { held: true }, mystery: { running: 0, target: 9 } }))).toBeNull();
});
