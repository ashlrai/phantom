import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { evictAll } from '../../data/cache.js';
import { BotsView } from './BotsView.js';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../data/mutations.js', () => ({ createBotFromTemplate: mocks.create }));

const TEMPLATES = ['pr-reviewer', 'release-scribe', 'ci-watchdog'].map((id, i) => ({
  id, name: ['PR reviewer', 'Release scribe', 'CI watchdog'][i], blurb: 'blurb', role: 'reviewer',
  avatar: { glyph: 'XX', hue: 10 }, channels: ['bus'], tasks: 2, crons: 1, memorySeed: 3,
}));

function stubFetch(bots: unknown[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => (String(url).includes('/templates') ? { templates: TEMPLATES } : { bots }),
    text: async () => '',
  })));
}
const mount = () => render(<BotsView />);

beforeEach(() => { evictAll(); mocks.create.mockReset(); stubFetch(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('BotsView', () => {
  it('shows the three starter templates', async () => {
    mount();
    for (const n of ['PR reviewer', 'Release scribe', 'CI watchdog']) expect(await screen.findByText(n)).toBeInTheDocument();
    expect(screen.getByText('No bots yet.')).toBeInTheDocument();
  });

  it('creates a bot from a template and reports disabled crons', async () => {
    mocks.create.mockResolvedValue({ bot: { id: 'rev-1', name: 'PR reviewer', automations: ['au_a'] }, profileVersion: 1, files: [] });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Use PR reviewer' }));
    fireEvent.change(screen.getByLabelText('Bot id'), { target: { value: 'rev-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create bot' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({ templateId: 'pr-reviewer', id: 'rev-1', name: 'PR reviewer' }));
    expect(await screen.findByRole('status')).toHaveTextContent('1 cron (disabled)');
  });

  it('rejects a bad id locally and surfaces a server refusal', async () => {
    mocks.create.mockRejectedValue(new Error('A bot named rev-1 already exists.'));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Use CI watchdog' }));
    fireEvent.change(screen.getByLabelText('Bot id'), { target: { value: 'Bad Id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create bot' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Id must be 2-24 characters');
    expect(mocks.create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Bot id'), { target: { value: 'rev-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create bot' }));
    expect(await screen.findByText('A bot named rev-1 already exists.')).toBeInTheDocument();
  });
});
