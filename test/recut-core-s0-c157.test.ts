import { describe, expect, it, vi } from 'vitest';
import { createAppAdapter, loopbackAppRequest } from '../src/core/drive/apps.js';
import type { VerseRequest } from '../src/core/verse/desktop-adapters.js';

describe('app drive adapter (recut #3151 via #4749)', () => {
  const request = vi.fn<VerseRequest>(async () => ({ status: 200, json: {} }));

  it('rejects a mismatched target before any request', async () => {
    const adapter = createAppAdapter('claude', { request });
    await expect(adapter({ target: 'devin', action: 'status', handle: 'abc', projectPath: '/' })).rejects.toThrow('Target mismatch');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects malformed session handles without a request', async () => {
    const adapter = createAppAdapter('codex', { request });
    await expect(adapter({ target: 'codex', action: 'status', handle: '../bad', projectPath: '/' })).rejects.toThrow('Invalid session handle');
    await expect(adapter({ target: 'codex', action: 'read-result', handle: '', projectPath: '/' })).rejects.toThrow('Invalid session handle');
    expect(request).not.toHaveBeenCalled();
  });

  it('enforces the 1-2000 prompt bound on start and send-prompt', async () => {
    const adapter = createAppAdapter('devin', { request });
    await expect(adapter({ target: 'devin', action: 'start', prompt: ' ', projectPath: '/' })).rejects.toThrow('1-2000');
    await expect(adapter({ target: 'devin', action: 'send-prompt', handle: 's', prompt: 'x'.repeat(2001), projectPath: '/' })).rejects.toThrow('1-2000');
    expect(request).not.toHaveBeenCalled();
  });

  it('allowlists only verse session API paths on the loopback request', async () => {
    const request2 = loopbackAppRequest('http://127.0.0.1:7777', 'read-token', 'write-token');
    await expect(request2('GET', '/api/verse/../etc/passwd')).rejects.toThrow('Invalid drive API path');
    await expect(request2('GET', '/api/other')).rejects.toThrow('Invalid drive API path');
    await expect(request2('GET', '/api/verse/sessions/' + 'x'.repeat(81))).rejects.toThrow('Invalid drive API path');
  });
});
