/**
 * SetupWizard.test.tsx — one primary action per screen, smart defaults,
 * keyboard-first, and no field that can carry a secret value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { evictAll } from '../../../data/cache.js';
import { healthReport } from '../health/health.test-support.js';
import { SetupWizard } from './SetupWizard.js';
import { getSetupWizardState, openSetupWizard, resetSetupWizard, SETUP_WIZARD_STORAGE_KEY } from './setup-wizard-store.js';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetSetupWizard();
  vi.stubGlobal('fetch', vi.fn(async () => json({ checkedAt: new Date().toISOString(), seats: [healthReport('claude'), healthReport('codex', { engine: 'codex' })] })));
  openSetupWizard();
});

afterEach(() => vi.unstubAllGlobals());

function primaryButtons(): HTMLElement[] {
  return within(screen.getByRole('dialog')).getAllByRole('button').filter((b) => b.className.includes('primary'));
}

describe('SetupWizard', () => {
  it('starts with every companion on, heroes first, and exactly one primary button', () => {
    render(<SetupWizard />);
    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBe(7);
    expect(switches.every((s) => s.getAttribute('aria-checked') === 'true')).toBe(true);
    expect(switches[0]).toHaveAccessibleName('Include Phantom Secrets');
    expect(switches[1]).toHaveAccessibleName('Include Locus');
    expect(primaryButtons()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument();
  });

  it('toggles a companion off and reveals details on click', async () => {
    const user = userEvent.setup();
    render(<SetupWizard />);
    await user.click(screen.getByRole('switch', { name: 'Include Lexicon' }));
    expect(getSetupWizardState().companions.lexicon).toBe(false);
    await user.click(screen.getByRole('button', { name: /Locus/ }));
    expect(screen.getByRole('button', { name: 'View on GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Star Locus on GitHub' })).toBeInTheDocument();
  });

  it('pre-fills resources from seats Phantom already sees and keeps one primary per step', async () => {
    const user = userEvent.setup();
    render(<SetupWizard />);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByRole('list', { name: 'Resources' })).toHaveTextContent('Claude Code'));
    expect(screen.getByRole('list', { name: 'Resources' })).toHaveTextContent('Codex');
    for (let i = 0; i < 3; i += 1) {
      expect(primaryButtons()).toHaveLength(1);
      await user.click(screen.getByRole('button', { name: 'Continue' }));
    }
    expect(screen.getByRole('button', { name: 'Finish' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    expect(getSetupWizardState().completedAt).not.toBeNull();
  });

  it('refuses a secret value typed into a resource field and never persists it', async () => {
    const user = userEvent.setup();
    render(<SetupWizard />);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: /Add an account/ }));
    const secret = 'sk-' + 'z'.repeat(40);
    await user.type(screen.getByLabelText('Label'), secret);
    expect(screen.getByRole('alert')).toHaveTextContent(/looks like a secret/);
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(localStorage.getItem(SETUP_WIZARD_STORAGE_KEY) ?? '').not.toContain(secret);
  });

  it('is keyboard-first: Alt+→ continues and Alt+← goes back', async () => {
    const user = userEvent.setup();
    render(<SetupWizard />);
    screen.getAllByRole('switch')[0]!.focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(getSetupWizardState().step).toBe(1);
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(getSetupWizardState().step).toBe(0);
  });
});
