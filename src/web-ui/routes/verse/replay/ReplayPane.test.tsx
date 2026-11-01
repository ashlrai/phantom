import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PaneProps } from '../panes/pane-registry.js';
import { ReplayPane } from './ReplayPane.js';
import { fixtureRecording } from './fixture.test-support.js';
import { isAgentWorkspaceEnabled } from './agent-workspace.js';

const host = { sendToChat: vi.fn(), addToMessage: vi.fn(), openPane: vi.fn(), closePane: vi.fn(), openTerminal: vi.fn(), openTerminalBelow: vi.fn(), openDiff: vi.fn(), openSession: vi.fn() };
function props(): PaneProps {
  return { paneId: 'run-replay', sessionId: 'session', session: null, roots: [], events: fixtureRecording().events as unknown as PaneProps['events'], turnFiles: [], visible: true, presentation: 'column', requests: { terminal: null, preview: null, diff: null }, host };
}
beforeEach(() => { localStorage.setItem('agentWorkspace', 'true'); });
afterEach(() => { localStorage.clear(); });

it('is default-off, accepts only the exact flag value, and guards restored tabs', () => {
  localStorage.clear();
  expect(isAgentWorkspaceEnabled()).toBe(false);
  localStorage.setItem('agentWorkspace', '1');
  expect(isAgentWorkspaceEnabled()).toBe(false);
  const rendered = render(<ReplayPane {...props()} />);
  expect(screen.queryByRole('region', { name: 'Run replay' })).toBeNull();
  localStorage.setItem('agentWorkspace', 'true');
  act(() => { window.dispatchEvent(new Event('agentWorkspace-changed')); });
  expect(screen.getByRole('region', { name: 'Run replay' })).toBeInTheDocument();
  localStorage.clear();
  act(() => { window.dispatchEvent(new StorageEvent('storage')); });
  expect(screen.queryByRole('region', { name: 'Run replay' })).toBeNull();
  rendered.unmount();
});

it('fails closed if storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('private'); });
  expect(isAgentWorkspaceEnabled()).toBe(false);
});

it('steps through the fixture, seeks back, restarts and never invokes execution or network', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network expected'));
  const user = userEvent.setup();
  render(<ReplayPane {...props()} />);
  expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  expect(screen.queryByText('Change the greeting to Hello.')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Next step' }));
  expect(screen.getByText('Change the greeting to Hello.')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('slider'), { target: { value: '5' } });
  expect(screen.getByText('npm test -- hello.test.ts')).toBeInTheDocument();
  expect(screen.queryByText('1 test passed. Exit code: 0')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Next step' }));
  expect(screen.getByText('1 test passed. Exit code: 0')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Previous' }));
  expect(screen.queryByText('1 test passed. Exit code: 0')).toBeNull();
  fireEvent.change(screen.getByRole('slider'), { target: { value: '8' } });
  expect(screen.getByRole('button', { name: 'Next step' })).toBeDisabled();
  expect(screen.getByText('End of recording.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Restart' }));
  expect(screen.getByRole('slider')).toHaveValue('0');
  expect(fetch).not.toHaveBeenCalled();
  for (const callback of Object.values(host)) expect(callback).not.toHaveBeenCalled();
});

it('renders imported HTML as inert text and redacts titles, messages, commands and output', () => {
  const fixture = fixtureRecording();
  fixture.events[0]!.text = '<img src=x onerror="alert(1)"> token=short';
  fixture.events[4]!.input = { command: 'echo password=hidden' };
  const p = { ...props(), events: fixture.events as unknown as PaneProps['events'] };
  const { container } = render(<ReplayPane {...p} />);
  fireEvent.change(screen.getByRole('slider'), { target: { value: '1' } });
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('<img src=x');
  expect(container.innerHTML).not.toContain('token=short');
  fireEvent.change(screen.getByRole('slider'), { target: { value: '5' } });
  expect(container.innerHTML).not.toContain('password=hidden');
  expect(container.textContent).toContain('[REDACTED]');
});

it('freezes the record until explicitly refreshed and resets on session changes', async () => {
  const user = userEvent.setup();
  const p = props();
  const { rerender } = render(<ReplayPane {...p} />);
  fireEvent.change(screen.getByRole('slider'), { target: { value: '1' } });
  const fixture = fixtureRecording();
  fixture.events[0]!.text = 'A later stored run';
  rerender(<ReplayPane {...p} events={fixture.events as unknown as PaneProps['events']} />);
  expect(screen.getByText('Change the greeting to Hello.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Use latest finished run' }));
  expect(screen.getByRole('slider')).toHaveValue('0');
  rerender(<ReplayPane {...p} sessionId="other" events={[]} />);
  expect(screen.queryByRole('slider')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('Finish an agent run');
});

it('opens local JSON and clears the old recording on malformed input without echoing errors', async () => {
  const user = userEvent.setup();
  render(<ReplayPane {...props()} />);
  const input = screen.getByLabelText('Open recording', { selector: 'input' });
  const file = new File(['{}'], 'run.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => JSON.stringify(fixtureRecording()) });
  await user.upload(input, file);
  expect(await screen.findByText('Fix the greeting')).toBeInTheDocument();
  const bad = new File(['bad'], 'bad.json', { type: 'application/json' });
  Object.defineProperty(bad, 'text', { value: async () => '{secret-value' });
  await user.upload(input, bad);
  expect(await screen.findByRole('status')).toHaveTextContent('Choose a complete, valid run recording');
  expect(screen.queryByRole('slider')).toBeNull();
  expect(document.body.innerHTML).not.toContain('secret-value');
});
