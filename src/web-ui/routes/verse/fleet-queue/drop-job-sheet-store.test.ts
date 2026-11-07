import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { DropJobDraft } from './drop-job-model.js';
import {
  dropJobDraftStorageKey,
  openDropJobSheet,
  readDropJobDraftStorage,
  resetDropJobSheetForTest,
  useDropJobSheetRequest,
} from './drop-job-sheet-store.js';

const seed: DropJobDraft = { id: 'MAINFIXABCDEF0', lane: 'codex-personal', tier: 'mid', body: 'Fix the red main.' };

beforeEach(() => { sessionStorage.clear(); resetDropJobSheetForTest(); });
afterEach(() => sessionStorage.clear());

it('seeds the sheet when no draft is stored', () => {
  const { result } = renderHook(useDropJobSheetRequest);
  expect(result.current).toBeNull();
  let outcome: unknown;
  act(() => { outcome = openDropJobSheet(seed); });
  expect(outcome).toBe('seeded');
  expect(result.current).toEqual({ seed });
});

it('keeps an existing unsent draft body, opens the sheet without a seed', () => {
  sessionStorage.setItem(dropJobDraftStorageKey, JSON.stringify({ id: 'KEEP1', lane: 'devin', tier: 'work', body: 'half written' }));
  const { result } = renderHook(useDropJobSheetRequest);
  let outcome: unknown;
  act(() => { outcome = openDropJobSheet(seed); });
  expect(outcome).toBe('kept');
  expect(result.current).toEqual({ seed: null });
  expect(readDropJobDraftStorage()).toMatchObject({ id: 'KEEP1', body: 'half written' });
});

it.each(['', '   \n  '])('seeds when the stored body is blank (%j)', body => {
  sessionStorage.setItem(dropJobDraftStorageKey, JSON.stringify({ id: 'OLD', lane: 'devin', tier: 'work', body }));
  const { result } = renderHook(useDropJobSheetRequest);
  let outcome: unknown;
  act(() => { outcome = openDropJobSheet(seed); });
  expect(outcome).toBe('seeded');
  expect(result.current).toEqual({ seed });
});

it('seeds when storage holds malformed json or a partial draft', () => {
  sessionStorage.setItem(dropJobDraftStorageKey, '{not json');
  expect(openDropJobSheet(seed)).toBe('seeded');
  sessionStorage.setItem(dropJobDraftStorageKey, JSON.stringify({ id: 'X', body: 'hi' }));
  expect(openDropJobSheet(seed)).toBe('seeded');
});
