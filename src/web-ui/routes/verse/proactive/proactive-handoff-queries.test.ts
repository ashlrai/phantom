import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { companionDigestToReference } from '../../../../core/proactive/coordination-wire.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import * as auth from '../../../data/auth-store.js';
import { installFetch, json, TEST_TOKEN } from '../context/context-fixtures.test-support.js';
import { fetchGrokBotHandoffPreview } from './proactive-queries.js';
const request = { taskId: 'ct_' + 'a'.repeat(32), attemptId: 'b'.repeat(64), epoch: 1, expectedRevision: 4,
  profileId: 'pa_' + 'c'.repeat(24), expectedProfileVersion: 2 };
const packetDigest = 'd'.repeat(64); const briefText = 'Manual copy is not acceptance or completion.\n{"goal":"Review synthetic PR"}';
const previewDigest = createHash('sha256').update(briefText).digest('hex');
const result = () => ({ schemaVersion: 1, taskId: request.taskId, attemptId: companionDigestToReference(request.attemptId), epoch: 1,
  revision: 4, profileId: request.profileId, profileVersion: 2, packetDigest: companionDigestToReference(packetDigest),
  previewDigest: companionDigestToReference(previewDigest), briefText, dispatchAuthorized: false, contextShared: false, transport: 'manual-copy' });
beforeEach(() => { setMutationToken(TEST_TOKEN); vi.stubGlobal('crypto', webcrypto); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });
describe('Grok handoff preview client boundary', () => {
  it('posts only the exact reviewed scope with mutation authority and validates byte digest', async () => {
    const { calls } = installFetch(() => json(result()));
    const read = await fetchGrokBotHandoffPreview({ ...request, expectedPreviewDigest: previewDigest }, packetDigest, new AbortController().signal);
    expect(read.previewDigest).toBe(previewDigest); expect(read.packetDigest).toBe(packetDigest);
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ path: '/api/verse/proactive-agents/coordination/handoff-preview', method: 'POST' });
    expect(calls[0]?.headers['x-ashlr-token']).toBe(TEST_TOKEN);
    expect(calls[0]?.body).toMatchObject({ taskId: request.taskId, expectedRevision: 4, expectedProfileVersion: 2 });
    expect((calls[0]?.body as { expectedPreviewDigest: string }).expectedPreviewDigest).toBe(companionDigestToReference(previewDigest));
  });
  it('does not send without mutation authority or after pre-abort', async () => {
    const { calls } = installFetch(() => json(result())); clearMutationToken();
    await expect(fetchGrokBotHandoffPreview(request, packetDigest, new AbortController().signal)).rejects.toThrow(/token/i);
    setMutationToken(TEST_TOKEN); const controller = new AbortController(); controller.abort();
    await expect(fetchGrokBotHandoffPreview(request, packetDigest, controller.signal)).rejects.toThrow('Aborted');
    expect(calls).toHaveLength(0);
  });
  it.each(['scope', 'revision', 'profile', 'packet', 'digest', 'text', 'authority', 'context', 'transport', 'size', 'extra'])('rejects mismatched %s output', async kind => {
    const value = result();
    const altered = { ...value, ...(kind === 'scope' ? { taskId: 'ct_' + 'f'.repeat(32) } : kind === 'revision' ? { revision: 5 }
      : kind === 'profile' ? { profileVersion: 3 } : kind === 'packet' ? { packetDigest: 'e'.repeat(64) }
        : kind === 'digest' ? { previewDigest: 'e'.repeat(64) } : kind === 'text' ? { briefText: 'Changed text with the original digest.' } : kind === 'authority' ? { dispatchAuthorized: true }
          : kind === 'context' ? { contextShared: true } : kind === 'transport' ? { transport: 'webhook' }
            : kind === 'size' ? { briefText: '界'.repeat(12_000) } : { unexpected: true }) };
    installFetch(() => json(altered));
    await expect(fetchGrokBotHandoffPreview(request, packetDigest, new AbortController().signal)).rejects.toThrow('could not be confirmed');
  });
  it('rejects a response after abort even if HTTP ignores cancellation, without renewing the action hold', async () => {
    let resolve!: (value: Response) => void;
    installFetch(() => new Promise<Response>(done => { resolve = done; }));
    const touch = vi.spyOn(auth, 'touchMutationHold'); const controller = new AbortController();
    const flight = fetchGrokBotHandoffPreview(request, packetDigest, controller.signal);
    controller.abort(); resolve(json(result()));
    await expect(flight).rejects.toMatchObject({ name: 'AbortError' }); expect(touch).not.toHaveBeenCalled();
  });
  it.each(['clear', 'rotate'])('refuses authority %s during HTTP without renewing the hold', async mode => {
    let resolve!: (value: Response) => void; installFetch(() => new Promise<Response>(done => { resolve = done; }));
    const flight = fetchGrokBotHandoffPreview(request, packetDigest, new AbortController().signal);
    if (mode === 'clear') clearMutationToken(); else setMutationToken('e'.repeat(64));
    const touch = vi.spyOn(auth, 'touchMutationHold'); resolve(json(result()));
    await expect(flight).rejects.toThrow(/token/i); expect(touch).not.toHaveBeenCalled();
  });
  it.each(['clear', 'rotate'])('refuses authority %s while digest verification is pending', async mode => {
    let resolve!: (value: ArrayBuffer) => void;
    const digest = vi.fn(() => new Promise<ArrayBuffer>(done => { resolve = done; }));
    vi.stubGlobal('crypto', { subtle: { digest } }); installFetch(() => json(result()));
    const flight = fetchGrokBotHandoffPreview(request, packetDigest, new AbortController().signal);
    await waitFor(() => expect(digest).toHaveBeenCalledOnce());
    if (mode === 'clear') clearMutationToken(); else setMutationToken('e'.repeat(64));
    const touch = vi.spyOn(auth, 'touchMutationHold'); resolve(Uint8Array.from(Buffer.from(previewDigest, 'hex')).buffer);
    await expect(flight).rejects.toThrow(/token/i); expect(touch).not.toHaveBeenCalled();
  });
});
