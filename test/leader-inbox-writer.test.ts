import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { approvedLeaderInboxAppender, leaderInboxRequestHash, validLeaderInboxReceipt, type LeaderInboxRequest } from '../src/core/agents/leader-inbox-writer.js';
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
const request: LeaderInboxRequest = { requestId: 'a'.repeat(64), channel: 'slack', ownerId: 'U0SYNTHETIC', receivedAt: 1793979396013, text: 'Synthetic body\n## user supplied heading' };
const receipt = () => ({ schema: 'mason-inbox-receipt.v1', requestId: request.requestId, requestSha256: leaderInboxRequestHash(request), status: 'appended' });
const invoke = vi.mocked(execFile);
afterEach(() => vi.resetAllMocks());
function processResult(stdout: string, error: Error | null = null) {
  const end = vi.fn();
  invoke.mockImplementation(((_file: unknown, _args: unknown, _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    queueMicrotask(() => callback(error, stdout));
    return { stdin: { on: vi.fn(), end } };
  }) as typeof execFile);
  return end;
}
describe('fixed approved Leader inbox writer', () => {
  it('uses only the fixed helper and metadata argv with a credential-free environment and stdin-only body', async () => {
    const end = processResult(JSON.stringify(receipt()));
    expect(await approvedLeaderInboxAppender(() => true)(request)).toEqual(receipt());
    expect(invoke).toHaveBeenCalledWith(join(homedir(), '.ashlr-runs/bin/mason-inbox-append'),
      ['--src', 'slack', '--id', request.requestId, '--received-at', String(request.receivedAt)],
      expect.objectContaining({ cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, maxBuffer: 1024, timeout: 25000 }), expect.any(Function));
    expect(end).toHaveBeenCalledExactlyOnceWith(request.text);
    expect(JSON.stringify(invoke.mock.calls[0]?.slice(0, 3))).not.toContain(request.text);
  });
  it('does not execute after current owner revocation or deadline expiry', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(approvedLeaderInboxAppender(() => true, controller.signal)(request)).rejects.toThrow('unavailable');
    await expect(approvedLeaderInboxAppender(() => false)(request)).rejects.toThrow('unavailable');
    expect(invoke).not.toHaveBeenCalled();
  });
  it('rejects missing, mismatched, body-forged and extra-field receipts', async () => {
    for (const value of ['', request.text, JSON.stringify({ ...receipt(), requestId: 'b'.repeat(64) }), JSON.stringify({ ...receipt(), requestSha256: 'b'.repeat(64) }), JSON.stringify({ ...receipt(), actor: 'mason' }), JSON.stringify({ ...receipt(), status: ['appended'] }), JSON.stringify({ ...receipt(), status: ['duplicate'] })]) {
      processResult(value);
      await expect(approvedLeaderInboxAppender(() => true)(request)).rejects.toThrow('invalid');
    }
    expect(validLeaderInboxReceipt(receipt(), { ...request, receivedAt: request.receivedAt + 1 })).toBe(false);
    expect(validLeaderInboxReceipt(receipt(), { ...request, text: 'Different' })).toBe(false);
  });
  it('keeps execution failure uncertain without forwarding raw errors or text', async () => {
    processResult(request.text, new Error('Synthetic private body must not escape'));
    await expect(approvedLeaderInboxAppender(() => true)(request)).rejects.toThrow(/^Leader inbox outcome is unconfirmed$/);
  });
  it('accepts only exact duplicate receipts and refuses malformed request metadata before execution', async () => {
    processResult(JSON.stringify({ ...receipt(), status: 'duplicate' }));
    expect(await approvedLeaderInboxAppender(() => true)(request)).toMatchObject({ status: 'duplicate' });
    invoke.mockClear();
    for (const changed of [{ requestId: '../bad' }, { receivedAt: Number.NaN }, { text: '\ud800' }, { channel: 'email' }]) {
      await expect(approvedLeaderInboxAppender(() => true)({ ...request, ...changed } as LeaderInboxRequest)).rejects.toThrow('unavailable');
    }
    expect(invoke).not.toHaveBeenCalled();
  });
});
