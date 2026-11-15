import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LeaderComposer } from './LeaderComposer.js';

const upload = vi.hoisted(() => vi.fn());
vi.mock('./composer-attachment.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./composer-attachment.js')>(), uploadAttachment: upload,
}));
vi.mock('../voice/VoiceInput.js', () => ({ default: () => null }));

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
const imagePaste = { clipboardData: { files: [file], items: [] } };

function setup(value = 'hello') {
  const onSend = vi.fn();
  const onChange = vi.fn();
  render(<LeaderComposer value={value} onChange={onChange} onSend={onSend} label="Message" placeholder="Say" />);
  return { onSend, onChange, box: screen.getByLabelText('Message') };
}

it('shows a chip and disables Send while the upload is pending, then sends with the ref line', async () => {
  let done!: (v: unknown) => void;
  upload.mockReturnValue(new Promise((r) => { done = r; }));
  const { onSend, box } = setup();
  fireEvent.paste(box, imagePaste);
  expect(screen.getByAltText('Attached screenshot')).toBeTruthy();
  const send = screen.getByRole('button', { name: 'Send to the Leader' });
  expect(send).toBeDisabled();
  expect(send).toHaveAttribute('title', 'Attaching screenshot…');
  done({ path: '/tmp/fake-runs/inbox-attachments/abc.png', sha256: 'abc', bytes: 3, type: 'image/png' });
  await waitFor(() => expect(send).toBeEnabled());
  fireEvent.click(send);
  expect(onSend).toHaveBeenCalledWith('hello\n[screenshot: /tmp/fake-runs/inbox-attachments/abc.png]');
  expect(screen.queryByAltText('Attached screenshot')).toBeNull();
});

it('shows the server reason on failure and keeps the typed text', async () => {
  upload.mockRejectedValue(new Error('image is over 8 MiB'));
  const { onChange, box } = setup('keep me');
  fireEvent.paste(box, imagePaste);
  expect(await screen.findByRole('alert')).toHaveTextContent('image is over 8 MiB');
  expect(screen.queryByAltText('Attached screenshot')).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
  expect(box).toHaveValue('keep me');
});

it('removing the chip revokes its object URL', () => {
  upload.mockReturnValue(new Promise(() => undefined));
  const { box } = setup();
  fireEvent.paste(box, imagePaste);
  fireEvent.click(screen.getByRole('button', { name: 'Remove screenshot' }));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  expect(screen.queryByAltText('Attached screenshot')).toBeNull();
});

it('leaves a plain-text paste alone', () => {
  const { box } = setup();
  const notPrevented = fireEvent.paste(box, { clipboardData: { files: [], items: [], getData: () => 'words' } });
  expect(notPrevented).toBe(true);
  expect(upload).not.toHaveBeenCalled();
  expect(screen.queryByAltText('Attached screenshot')).toBeNull();
});
