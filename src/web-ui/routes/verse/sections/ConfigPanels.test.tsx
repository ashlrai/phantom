import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const copyText = vi.fn(async (_text: string) => true);
const saveUiSettingsText = vi.fn(async (_text: string) => ({ ok: true, problems: [] as string[] }));
const reloadUiSettingsFromFile = vi.fn(async () => undefined);
vi.mock('../../../components/primitives/clipboard.js', () => ({ copyText: (t: string) => copyText(t) }));
vi.mock('../../../data/ui-settings-sync.js', () => ({
  useUiSettingsStatus: () => ({ phase: 'synced', path: '/home/me/.ashlr/ui.json', exists: true, problems: ['unknown group "x"'], detail: null }),
  currentUiSettingsText: () => '{\n  "layout": {}\n}\n',
  saveUiSettingsText: (t: string) => saveUiSettingsText(t),
  reloadUiSettingsFromFile: () => reloadUiSettingsFromFile(),
}));

import { ConfigFilePanel } from './ConfigFilePanel.js';
import { LayoutPanel } from './LayoutPanel.js';
import { getVerseUiState, resetVerseUi, VERSE_SIDEBAR } from '../verse-ui-store.js';

beforeEach(() => { resetVerseUi(); vi.clearAllMocks(); });

describe('LayoutPanel', () => {
  it('writes panel visibility and width to the shell store', () => {
    render(<LayoutPanel />);
    fireEvent.click(screen.getByRole('switch', { name: 'Show resources panel' }));
    expect(getVerseUiState().resourcesOpen).toBe(false);
    fireEvent.click(screen.getByRole('switch', { name: 'Show sidebar' }));
    expect(getVerseUiState().sidebarCollapsed).toBe(true);
    fireEvent.change(screen.getAllByRole('slider')[0]!, { target: { value: '300' } });
    expect(getVerseUiState().sidebarWidth).toBe(300);
    fireEvent.click(screen.getByRole('button', { name: 'Reset layout' }));
    expect(getVerseUiState()).toMatchObject({ sidebarWidth: VERSE_SIDEBAR.def, resourcesOpen: true, sidebarCollapsed: false });
  });
});

describe('ConfigFilePanel', () => {
  it('shows the path, copies it, and surfaces the file’s problems', async () => {
    render(<ConfigFilePanel />);
    expect(screen.getByText('/home/me/.ashlr/ui.json')).toBeInTheDocument();
    expect(screen.getByText('unknown group "x"')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy file path' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy file path' })).toHaveTextContent('Copied'));
    expect(copyText).toHaveBeenCalledWith('/home/me/.ashlr/ui.json');
  });

  it('saves edited text and reloads from the file on request', async () => {
    render(<ConfigFilePanel />);
    const save = screen.getByRole('button', { name: 'Save to file' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: /Contents/ }), { target: { value: '{"layout":{"railExpanded":true}}' } });
    fireEvent.click(save);
    await waitFor(() => expect(saveUiSettingsText).toHaveBeenCalledWith('{"layout":{"railExpanded":true}}'));
    fireEvent.click(screen.getByRole('button', { name: 'Reload from file' }));
    await waitFor(() => expect(reloadUiSettingsFromFile).toHaveBeenCalled());
  });
});
