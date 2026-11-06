import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { TemplateGallery } from './TemplateGallery.js';
import { createAgentTemplate, readAgentTemplates } from '../../../data/agent-templates.js';

beforeEach(() => { localStorage.clear(); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden'); })); });
afterEach(() => { vi.unstubAllGlobals(); });
async function openGallery() {
  fireEvent.click(screen.getByText('Local agent templates'));
  // jsdom dispatches the native details toggle asynchronously.
  await waitFor(() => expect(screen.getByLabelText('Template name')).toBeEnabled());
}
function Harness() {
  const [task, setTask] = useState({ title: 'Fix login', prompt: 'Fix the redirect and test it.' });
  return <><output aria-label="Current task">{task.title}: {task.prompt}</output>
    <button onClick={() => setTask({ title: '', prompt: '' })}>Clear draft</button>
    <TemplateGallery {...task} onApply={setTask} /></>;
}
it('creates, persists across remounts, applies to a draft, and deletes without network', async () => {
  const view = render(<Harness />);
  await openGallery();
  fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Login repair' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save current task as template' }));
  expect(readAgentTemplates()).toHaveLength(1);
  view.unmount();
  render(<Harness />);
  await openGallery();
  fireEvent.click(screen.getByText('Clear draft'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply Login repair' }));
  expect(screen.getByLabelText('Current task')).toHaveTextContent('Fix login: Fix the redirect and test it.');
  fireEvent.click(screen.getByRole('button', { name: 'Delete Login repair' }));
  expect(readAgentTemplates()).toEqual([]);
  expect(screen.getByText(/No local templates yet/)).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});
it('refuses duplicate names and invalid input without overwriting saved templates', () => {
  createAgentTemplate({ name: 'Review', title: '', prompt: 'Review code' });
  expect(() => createAgentTemplate({ name: ' review ', title: '', prompt: 'Other' })).toThrow('unique');
  expect(() => createAgentTemplate({ name: 'Empty', title: '', prompt: ' ' })).toThrow();
  expect(() => createAgentTemplate({ name: 'Long', title: '', prompt: 'x'.repeat(20001) })).toThrow();
  expect(readAgentTemplates()).toHaveLength(1);
});
it('preserves malformed storage and reports read failure', async () => {
  localStorage.setItem('ashlr.verse.agent-templates.v1', '{broken');
  render(<Harness />);
  fireEvent.click(screen.getByText('Local agent templates'));
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
  expect(screen.getByRole('button', { name: 'Save current task as template' })).toBeDisabled();
  expect(localStorage.getItem('ashlr.verse.agent-templates.v1')).toBe('{broken');
});
it('reports failed writes without displaying an unsaved template', async () => {
  render(<Harness />); await openGallery();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Unsaved' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save current task as template' }));
  expect(screen.getByRole('alert')).toHaveTextContent('could not be saved');
  expect(screen.queryByRole('button', { name: 'Apply Unsaved' })).not.toBeInTheDocument();
});
it('retains a template when deletion fails and disables changes while launching', async () => {
  createAgentTemplate({ name: 'Keep', title: 'Title', prompt: 'Task' });
  const apply = vi.fn();
  const view = render(<TemplateGallery title="" prompt="Task" onApply={apply} />);
  await openGallery();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
  fireEvent.click(screen.getByRole('button', { name: 'Delete Keep' }));
  expect(screen.getByRole('alert')).toHaveTextContent('could not be deleted');
  expect(readAgentTemplates()).toHaveLength(1);
  view.rerender(<TemplateGallery title="" prompt="Task" onApply={apply} disabled />);
  expect(screen.getByRole('button', { name: 'Apply Keep' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Delete Keep' })).toBeDisabled();
  expect(apply).not.toHaveBeenCalled();
});
