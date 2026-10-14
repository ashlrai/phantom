import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportContextPane } from './ImportContextPane.js';
import { contextImportSelectionDigest } from '../../../../../core/verse/context-import-preview.js';
import type { ContextImportItem, ContextImportPreview, ContextImportRecord } from '../../../../../core/verse/context-import-types.js';
const f = vi.hoisted(() => ({ insert: vi.fn(), memory: vi.fn() }));
vi.mock('../../chat/composer-bridge.js', () => ({ insertIntoComposer: f.insert }));
vi.mock('../../context/use-token-gate.js', () => ({ useTokenGate: () => ({ run: async (_reason: string, action: () => Promise<unknown>) => action(), dialog: { open: false, reason: '', onClose() {}, onUnlocked() {} } }) }));
vi.mock('../../context/MemoryPanel.js', () => ({ MemoryPanel: (props: unknown) => { f.memory(props); return <p>Editable memory draft</p>; } }));
vi.mock('../../../../components/auth/MutationTokenDialog.js', () => ({ MutationTokenDialog: () => null }));
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('crypto', webcrypto); f.insert.mockReturnValue(true); });
afterEach(() => vi.unstubAllGlobals());
function backend() {
  const save = vi.fn(async (_project: string, preview: ContextImportPreview, items: ContextImportItem[]) => ({
    schemaVersion: 1, id: 'ctx_' + 'a'.repeat(64), projectDigest: 'sha256_' + 'b'.repeat(64), claimedProvider: preview.claimedProvider,
    provenance: preview.provenance, sourceLabel: preview.sourceLabel, sourceDigest: preview.sourceDigest, transformations: preview.transformations,
    selectionDigest: await contextImportSelectionDigest(items as ContextImportRecord['items']), items, importedAt: '2026-10-14T00:00:00.000Z',
    trust: 'untrusted-external-data', authority: false, autoInject: false,
  } as ContextImportRecord));
  return { save };
}
async function selectPreview() {
  fireEvent.change(screen.getByLabelText('Paste context'), { target: { value: 'Reference source text, not a memory instruction.' } });
  await userEvent.click(screen.getByRole('button', { name: 'Preview context' }));
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Imported note 1' }));
}
async function saveReference() {
  await userEvent.click(screen.getByRole('checkbox', { name: /I reviewed the selected items/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Save selected reference' }));
  await screen.findByRole('heading', { name: 'Reference ready' });
}
describe('local context selection and reviewed memory', () => {
  it('previews locally, requires selection and confirmation, persists selected edited content only', async () => {
    const api = backend(); render(<ImportContextPane sessionId="chat-1" projectPath="/fixture/project" api={api} />);
    expect(api.save).not.toHaveBeenCalled(); await selectPreview();
    expect(api.save).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Save selected reference' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Edit selected reference'), { target: { value: 'Selected and edited reference.' } });
    await saveReference();
    expect(api.save).toHaveBeenCalledExactlyOnceWith('/fixture/project', expect.objectContaining({ trust: 'untrusted-external-data' }),
      [expect.objectContaining({ text: 'Selected and edited reference.' })], expect.any(AbortSignal));
    expect(f.memory).not.toHaveBeenCalled(); expect(f.insert).not.toHaveBeenCalled();
  });
  it('keeps facts blank and adds only operator-rewritten facts to a separate editable memory draft', async () => {
    const api = backend(); render(<ImportContextPane sessionId="chat-1" projectPath="/fixture/project" api={api} />);
    await selectPreview(); await saveReference();
    expect(screen.getByLabelText('Facts I have rewritten and reviewed')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Review memory draft' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Facts I have rewritten and reviewed'), { target: { value: 'Keep progress updates concise.' } });
    await userEvent.click(screen.getByRole('button', { name: 'Review memory draft' }));
    const props = f.memory.mock.calls.at(-1)![0];
    expect(props.projectPath).toBe('/fixture/project'); expect(props.reviewedDraft.text).toContain('Keep progress updates concise.');
    expect(props.reviewedDraft.text).not.toContain('Reference source text');
    expect(screen.getByLabelText('Project folder')).toBeDisabled();
    expect(screen.getByText('Editable memory draft')).toBeInTheDocument();
    expect(api.save).toHaveBeenCalledTimes(1);
  });
  it('adds saved references to a message draft with untrusted framing, never to memory or a sent turn', async () => {
    const api = backend(); render(<ImportContextPane sessionId="chat-1" projectPath="/fixture/project" api={api} />);
    await selectPreview(); await saveReference(); await userEvent.click(screen.getByRole('button', { name: 'Add reference to message' }));
    expect(f.insert).toHaveBeenCalledExactlyOnceWith('chat-1', expect.stringContaining('untrusted historical data'));
    expect(f.memory).not.toHaveBeenCalled(); expect(screen.getByText(/Review it before sending/)).toBeInTheDocument();
  });
  it('resets preview selection and reviewed facts when the input source changes', async () => {
    const api = backend(); render(<ImportContextPane sessionId="chat-1" projectPath="/fixture/project" api={api} />);
    await selectPreview(); await saveReference();
    fireEvent.change(screen.getByLabelText('Facts I have rewritten and reviewed'), { target: { value: 'A fact.' } });
    await userEvent.selectOptions(screen.getByLabelText('Source'), 'claude');
    expect(screen.queryByRole('heading', { name: 'Reference ready' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Facts I have rewritten and reviewed')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Imported note 1' })).not.toBeInTheDocument();
  });
  it('refuses oversized paste or unsupported JSON without a server call or silent truncation', async () => {
    const api = backend(); render(<ImportContextPane sessionId={null} projectPath={null} api={api} />);
    fireEvent.change(screen.getByLabelText('Paste context'), { target: { value: 'x'.repeat(256 * 1024 + 1) } });
    expect(screen.getByRole('alert')).toHaveTextContent('nothing is truncated'); expect(screen.getByRole('button', { name: 'Preview context' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Paste context'), { target: { value: '{"schemaVersion":1,"type":"phantom-context-capsule","claimedProvider":"chatgpt","items":null}' } });
    await userEvent.click(screen.getByRole('button', { name: 'Preview context' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not supported'); expect(api.save).not.toHaveBeenCalled();
  });
  it('keeps project-scoped references out of a different active chat', async () => {
    const api = backend(); render(<ImportContextPane sessionId="chat-1" projectPath="/fixture/project" api={api} />);
    await selectPreview(); fireEvent.change(screen.getByLabelText('Project folder'), { target: { value: '/fixture/other' } });
    await saveReference();
    expect(api.save).toHaveBeenCalledWith('/fixture/other', expect.anything(), expect.anything(), expect.anything());
    expect(screen.getByRole('button', { name: 'Add reference to message' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy reference' })).toBeEnabled(); expect(f.insert).not.toHaveBeenCalled();
  });
  it('ignores a completed save after the pane unmounts and aborts its readback signal', async () => {
    let finish!: (record: ContextImportRecord) => void; let signal!: AbortSignal;
    const api = { save: vi.fn((_project, _preview, _items, abort) => { signal = abort; return new Promise<ContextImportRecord>(resolve => { finish = resolve; }); }) };
    const view = render(<ImportContextPane sessionId="chat-1" projectPath="/fixture/project" api={api} />);
    await selectPreview(); await userEvent.click(screen.getByRole('checkbox', { name: /I reviewed the selected items/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save selected reference' }));
    await waitFor(() => expect(api.save).toHaveBeenCalledOnce()); view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => finish({} as ContextImportRecord)); expect(f.memory).not.toHaveBeenCalled(); expect(f.insert).not.toHaveBeenCalled();
  });
});
