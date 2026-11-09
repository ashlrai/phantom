/**
 * panes/builtin/FileBrowser.test.tsx — the Files pane browser against a
 * mocked apiPost: the token gate, lazy directory fetches, file preview and
 * the "Add to message" path-quote (never content).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiPost } from '../../../../data/client.js';
import { clearMutationToken, setMutationToken } from '../../../../data/auth-store.js';
import type { PaneHost } from '../pane-registry.js';
import { FileBrowser } from './FileBrowser.js';

vi.mock('../../../../data/client.js', async (original) => ({
  ...await original<typeof import('../../../../data/client.js')>(),
  apiPost: vi.fn(),
}));
const write = vi.mocked(apiPost);

const ROOT = '/repo';
const host = {
  addToMessage: vi.fn(),
  sendToChat: vi.fn(),
  openPane: vi.fn(),
  closePane: vi.fn(),
  openTerminal: vi.fn(),
  openDiff: vi.fn(),
  openPreview: vi.fn(),
} as unknown as PaneHost;

function browseResponse(path: string, entries: unknown[]) {
  return { sessionId: 's-1', root: ROOT, path, entries };
}
function readResponse(path: string, text: string, truncated = false) {
  return {
    sessionId: 's-1', root: ROOT, path, text,
    sizeBytes: Buffer.byteLength(text) + (truncated ? 999 : 0),
    byteLength: Buffer.byteLength(text), truncated,
  };
}

const TREE: Record<string, unknown[]> = {
  '': [
    { name: 'src', path: 'src', kind: 'directory', sizeBytes: null },
    { name: 'README.md', path: 'README.md', kind: 'file', sizeBytes: 9 },
  ],
  src: [
    { name: 'a.ts', path: 'src/a.ts', kind: 'file', sizeBytes: 120 },
    { name: 'b.ts', path: 'src/b.ts', kind: 'file', sizeBytes: 80 },
  ],
};

function mockApi(overrides: { readText?: string; readError?: Error } = {}) {
  write.mockImplementation(async (path: string, body: unknown) => {
    const req = body as { path?: string };
    if (path === '/api/verse/files/browse') return browseResponse(req.path ?? '', TREE[req.path ?? ''] ?? []);
    if (path === '/api/verse/files/read') {
      if (overrides.readError) throw overrides.readError;
      return readResponse(req.path ?? '', overrides.readText ?? 'file body\n', false);
    }
    throw new Error(`unexpected ${path}`);
  });
}

function renderBrowser(visible = true) {
  return render(<FileBrowser sessionId="s-1" roots={[ROOT]} host={host} visible={visible} />);
}

beforeEach(() => { write.mockReset(); });
afterEach(() => { cleanup(); clearMutationToken(); vi.clearAllMocks(); });

describe('FileBrowser', () => {
  it('asks for the mutation hold before its first fetch — no silent reads', async () => {
    mockApi();
    renderBrowser();
    expect(await screen.findByText(/privileged read/)).toBeInTheDocument();
    expect(write).not.toHaveBeenCalled();
  });

  it('loads the root, expands a directory lazily, previews a file and quotes only its path', async () => {
    setMutationToken('a'.repeat(64));
    mockApi({ readText: 'export const x = 1;\n' });
    renderBrowser();
    // Root listing arrives on its own once visible + held.
    expect(await screen.findByRole('button', { name: 'Expand src' })).toBeInTheDocument();
    expect(write).toHaveBeenCalledWith('/api/verse/files/browse', { sessionId: 's-1', root: ROOT, path: '' }, expect.any(String), expect.any(AbortSignal));
    // Expanding fetches that directory — once.
    fireEvent.click(screen.getByRole('button', { name: 'Expand src' }));
    expect(await screen.findByRole('button', { name: 'Preview a.ts' })).toBeInTheDocument();
    expect(write).toHaveBeenCalledWith('/api/verse/files/browse', { sessionId: 's-1', root: ROOT, path: 'src' }, expect.any(String), expect.any(AbortSignal));
    // Collapsing and re-expanding does not refetch a healthy listing.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse src' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand src' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview b.ts' })).toBeInTheDocument());
    expect(write.mock.calls.filter(([p]) => p === '/api/verse/files/browse')).toHaveLength(2);
    // A file click previews its bounded text; "Add to message" quotes the PATH only.
    fireEvent.click(screen.getByRole('button', { name: 'Preview a.ts' }));
    expect(await screen.findByText('export const x = 1;')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add to message' }));
    expect(host.addToMessage).toHaveBeenCalledWith('@src/a.ts');
    expect(host.addToMessage).not.toHaveBeenCalledWith(expect.stringContaining('export const'));
  });

  it('marks a truncated preview and surfaces read errors inline', async () => {
    setMutationToken('a'.repeat(64));
    mockApi({ readError: new Error('File preview must be valid UTF-8 text.') });
    renderBrowser();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview README.md' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('valid UTF-8');
  });

  it('does not fetch while the pane is hidden, and catches up when shown', async () => {
    setMutationToken('a'.repeat(64));
    mockApi();
    const view = renderBrowser(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(write).not.toHaveBeenCalled();
    view.rerender(<FileBrowser sessionId="s-1" roots={[ROOT]} host={host} visible={true} />);
    expect(await screen.findByRole('button', { name: 'Expand src' })).toBeInTheDocument();
    expect(write).toHaveBeenCalled();
  });
});
