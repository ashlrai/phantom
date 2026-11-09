import { afterEach, beforeEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { resetDropJobSheetForTest, useDropJobSheetRequest } from '../fleet-queue/drop-job-sheet-store.js';
import { CapabilityGapsPanel } from './CapabilityGapsPanel.js';
import { capabilityGapsView } from './capability-gaps-model.js';

const view = capabilityGapsView();
beforeEach(() => { sessionStorage.clear(); resetDropJobSheetForTest(); });
afterEach(cleanup);

it('renders the headline and the held line', () => {
  render(<CapabilityGapsPanel />);
  expect(screen.getByText(view.headline)).toBeInTheDocument();
  expect(screen.getByText(view.heldLine)).toBeInTheDocument();
});

it('Draft job opens the sheet with a body naming the surface id', () => {
  const sheet = renderHook(useDropJobSheetRequest);
  render(<CapabilityGapsPanel />);
  const buttons = screen.getAllByRole('button', { name: 'Draft job' });
  expect(buttons).toHaveLength(view.top.length);
  act(() => { fireEvent.click(buttons[0]!); });
  expect(sheet.result.current?.seed?.body).toContain(view.top[0]!.id);
});

it('has a Draft button only on draftable rows', () => {
  render(<CapabilityGapsPanel />);
  expect(screen.getAllByRole('button', { name: 'Draft job' })).toHaveLength(view.top.length);
  expect(document.querySelectorAll('[data-surface]')).toHaveLength(view.top.length);
});
