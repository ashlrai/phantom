import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { ATTACHMENT_PATH } from '../leader/composer-attachment.js';
import { ReplyAttachment } from './ReplyAttachment.js';

const TOKEN = 'a'.repeat(64);
const PATH = '/tmp/fake-runs/inbox-attachments/0123456789abcdef.png';
const MARKER = `[screenshot: ${PATH}]`;
const png = (name = 'shot.png', bytes = 2048) => new File([new Uint8Array(bytes)], name, { type: 'image/png' });
const ok = () => new Response(JSON.stringify({ path: PATH, sha256: 'x', bytes: 2048, type: 'image/png' }), { status: 200 });

let fetchMock: ReturnType<typeof vi.fn>;
let revoked: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setMutationToken(TOKEN);
  fetchMock = vi.fn(async () => ok());
  revoked = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:local'), revokeObjectURL: revoked }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearMutationToken(); });

/** The reply form as the pane lays it out: the box, then the attachment row inside the same form. */
function Harness({ initial = '', disabled = false, onSubmit = () => {} }: { initial?: string; disabled?: boolean; onSubmit?: () => void }) {
  const [draft, setDraft] = useState(initial);
  return <form onSubmit={event => { event.preventDefault(); onSubmit(); }}>
    <textarea aria-label="Reply to the Leader" value={draft} onChange={event => setDraft(event.target.value)} />
    <ReplyAttachment draft={draft} onDraft={setDraft} disabled={disabled} />
  </form>;
}
const box = () => screen.getByLabelText<HTMLTextAreaElement>('Reply to the Leader');

describe('ReplyAttachment', () => {
  it('uploads a pasted image with the mutation token and adds its line to the draft', async () => {
    render(<Harness initial="look at this" />);
    const file = png();
    fireEvent.paste(box(), { clipboardData: { files: [file], items: [] } });
    expect(screen.getByRole('status')).toHaveTextContent('Attaching screenshot… 2 KB');
    await waitFor(() => expect(box().value).toBe(`look at this\n${MARKER}`));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(ATTACHMENT_PATH);
    expect(init).toMatchObject({ method: 'POST', body: file, headers: { 'content-type': 'image/png', 'x-ashlr-token': TOKEN } });
    const chips = screen.getByRole('list', { name: 'Attached screenshots' });
    expect(chips).toHaveTextContent('Screenshot · 2 KB');
    expect(chips.querySelector('img')).toHaveAttribute('src', 'blob:local');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('leaves a text paste to the box', () => {
    render(<Harness />);
    const event = fireEvent.paste(box(), { clipboardData: { files: [], items: [] } });
    expect(event).toBe(true); // not prevented
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('takes a dropped image, and says so while it is held over the reply area', async () => {
    render(<Harness />);
    fireEvent.dragOver(box(), { dataTransfer: { types: ['Files'], files: [], items: [] } });
    expect(screen.getByText('Drop the image to attach it.')).toBeInTheDocument();
    fireEvent.drop(box(), { dataTransfer: { types: ['Files'], files: [png()], items: [] } });
    expect(screen.queryByText('Drop the image to attach it.')).toBeNull();
    await waitFor(() => expect(box().value).toBe(MARKER));
  });

  it('claims a dropped file that is not an image and explains, without uploading', () => {
    render(<Harness />);
    const pdf = new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' });
    const allowed = fireEvent.drop(box(), { dataTransfer: { types: ['Files'], files: [pdf], items: [] } });
    expect(allowed).toBe(false); // the browser must not navigate to the file
    expect(screen.getByRole('alert')).toHaveTextContent('Only PNG, JPEG or WebP screenshots can be attached.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an image type or size the server would refuse, before any upload', () => {
    render(<Harness />);
    fireEvent.paste(box(), { clipboardData: { files: [new File(['GIF89a'], 'a.gif', { type: 'image/gif' })], items: [] } });
    expect(screen.getByRole('alert')).toHaveTextContent('Only PNG, JPEG or WebP screenshots can be attached.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('picks a file from the Attach screenshot button', async () => {
    const { container } = render(<Harness />);
    expect(screen.getByRole('button', { name: 'Attach screenshot' })).toBeEnabled();
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [png()] } });
    await waitFor(() => expect(box().value).toBe(MARKER));
  });

  it('shows the server\'s reason when the upload fails and leaves the draft alone', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'This server is read-only.' }), { status: 403 }));
    render(<Harness initial="hello" />);
    fireEvent.paste(box(), { clipboardData: { files: [png()], items: [] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('This server is read-only.');
    expect(box().value).toBe('hello');
    expect(screen.queryByRole('list', { name: 'Attached screenshots' })).toBeNull();
    expect(revoked).toHaveBeenCalledWith('blob:local');
  });

  it('removes the chip and its line with Remove, and when the line is deleted by hand', async () => {
    render(<Harness initial="look" />);
    fireEvent.paste(box(), { clipboardData: { files: [png()], items: [] } });
    await waitFor(() => expect(box().value).toBe(`look\n${MARKER}`));
    fireEvent.click(screen.getByRole('button', { name: 'Remove screenshot 0123456789abcdef.png' }));
    expect(box().value).toBe('look');
    expect(screen.queryByRole('list', { name: 'Attached screenshots' })).toBeNull();
    expect(revoked).toHaveBeenCalledWith('blob:local');

    fireEvent.paste(box(), { clipboardData: { files: [png()], items: [] } });
    await waitFor(() => expect(box().value).toBe(`look\n${MARKER}`));
    fireEvent.change(box(), { target: { value: '' } }); // what Send does to the draft
    expect(screen.queryByRole('list', { name: 'Attached screenshots' })).toBeNull();
  });

  it('shows a marker it did not upload (a recalled message) as a chip by name', () => {
    render(<Harness initial={`again\n${MARKER}`} />);
    expect(screen.getByRole('list', { name: 'Attached screenshots' })).toHaveTextContent('Screenshot 0123456789abcdef.png');
  });

  it('cancels an upload in flight: nothing joins the draft', async () => {
    let finish: (res: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    render(<Harness initial="hi" />);
    fireEvent.paste(box(), { clipboardData: { files: [png()], items: [] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => { finish(ok()); });
    expect(box().value).toBe('hi');
    expect(revoked).toHaveBeenCalledWith('blob:local');
  });

  it('asks for the mutation token when none is held, then uploads without sending the reply', async () => {
    clearMutationToken();
    const onSubmit = vi.fn();
    render(<Harness initial="hello" onSubmit={onSubmit} />);
    fireEvent.paste(box(), { clipboardData: { files: [png()], items: [] } });
    const dialog = await screen.findByRole('dialog', { name: 'Unlock actions' });
    expect(dialog).toHaveTextContent('Attaching a screenshot requires the dispatch token.');
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(dialog.querySelector('input')!, { target: { value: TOKEN } });
    fireEvent.submit(dialog.querySelector('form')!);
    await waitFor(() => expect(box().value).toBe(`hello\n${MARKER}`));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('attaches nothing while the reply is sending or the console is read-only', () => {
    render(<Harness disabled />);
    expect(screen.getByRole('button', { name: 'Attach screenshot' })).toBeDisabled();
    fireEvent.paste(box(), { clipboardData: { files: [png()], items: [] } });
    const allowed = fireEvent.drop(box(), { dataTransfer: { types: ['Files'], files: [png()], items: [] } });
    expect(allowed).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
