import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
const { execFile } = vi.hoisted(() => ({ execFile: vi.fn((_file, _args, _opts, cb) => cb(null, '', '')) }));
vi.mock('node:child_process', () => ({ execFile }));
import { sendIMessage } from '../src/core/integrations/imessage.js';
import { sendIMessageOutbox } from '../src/core/comms/imessage-outbox.js';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const cfg = { comms: { enabled: true, imessageHandle: '<MASON_HANDLE>', imessageAllow: ['<OTHER_HANDLE>'] } } as AshlrConfig;
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks(); execFile.mockClear(); });
describe('self-only iMessage sends', () => {
  it('never invokes osascript for an intake-allowlisted third party', async () => {
    expect(await sendIMessage('hello', cfg, '<OTHER_HANDLE>')).toEqual({ ok: false, reason: 'not_self' });
    expect(execFile).not.toHaveBeenCalled();
  });
  it('compares normalized full handles and uses participant addressing', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    expect(await sendIMessage('hello', cfg, ' <mason_handle> ')).toEqual({ ok: true });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[1][1]).toContain('to participant');
  });
  it('rejects empty, prefix and suffix destinations', async () => {
    for (const to of ['', '<MASON_HANDLE>extra', '<MASON']) {
      expect(await sendIMessage('hello', cfg, to)).toEqual({ ok: false, reason: 'not_self' });
    }
    expect(execFile).not.toHaveBeenCalled();
  });
  it('keeps third-party outbox delivery denied pending draft integration', async () => {
    expect(await sendIMessageOutbox('hello', cfg, '<OTHER_HANDLE>')).toEqual({ ok: false, reason: 'drafts_unavailable' });
    expect(execFile).not.toHaveBeenCalled();
  });
});
