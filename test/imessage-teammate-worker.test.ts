import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import { recordTeammateText, readTeammateTexts, senderIdFor } from '../src/core/comms/imessage-teammate-inbox.js';
import { runTeammateResponder, teammateNeedsReply, generateLocalTeammateReply } from '../src/core/comms/imessage-teammate-worker.js';

let runsDir: string;
const cfg = {} as AshlrConfig;
const now = () => 1793933400000;
const receipt = { rowid: 99, sent: true, delivered: true, error: 0 };
const seed = (text = 'Please send the current release blocker?') => recordTeammateText({ rowid: 10, handle: 'agent@example.test', text }, runsDir, new Date(now()));
const state = () => JSON.parse(readFileSync(join(runsDir, 'imessage/teammate-replies.json'), 'utf8')) as { replies: Array<{ state: string; claimUntil: number }> };
const options = () => ({ runsDir, now, approved: () => 'agent@example.test', generate: vi.fn(async () => 'Release qualification is unknown; the existing DESKTOP owner is reconciling it.'), send: vi.fn(async () => 'accepted' as const), reconcile: vi.fn(async () => receipt) });
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'imessage-worker-')); });
afterEach(() => { vi.unstubAllGlobals(); rmSync(runsDir, { recursive: true, force: true }); });

describe('teammate worker', () => {
  it('sends one contextual reply, records proof, and deduplicates across restarts', async () => {
    seed(); const deps = options();
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ state: 'healthy', sent: 1 });
    expect(deps.send).toHaveBeenCalledOnce();
    expect(readTeammateTexts({ runsDir }).texts).toHaveLength(0);
    expect(state().replies[0]?.state).toBe('sent');
    await runTeammateResponder(cfg, deps);
    expect(deps.send).toHaveBeenCalledOnce();
    expect(readFileSync(join(runsDir, 'imessage/teammate-replies.json'), 'utf8')).not.toContain('agent@example.test');
  });
  it('never retries an uncertain native send; it reconciles the exact durable draft later', async () => {
    seed(); const deps = options(); deps.reconcile = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(receipt);
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ state: 'pending', pending: 1, sent: 0 });
    expect(state().replies[0]?.state).toBe('sending');
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ sent: 1 });
    expect(deps.send).toHaveBeenCalledOnce();
    expect(deps.generate).toHaveBeenCalledOnce();
  });
  it('retains a durable uncertain send even when the transport throws', async () => {
    seed(); const deps = options(); deps.send.mockRejectedValue(new Error('timeout'));
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ state: 'unavailable' });
    expect(state().replies[0]?.state).toBe('sending');
    deps.reconcile = vi.fn().mockResolvedValue(null);
    await runTeammateResponder(cfg, deps);
    expect(deps.send).toHaveBeenCalledOnce();
  });
  it('cannot send or generate for an unapproved identity', async () => {
    seed(); const deps = { ...options(), approved: () => null };
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ pending: 1 });
    expect(deps.send).not.toHaveBeenCalled(); expect(deps.generate).not.toHaveBeenCalled();
  });
  it('retains decision and action requests for leader review without generating or sending', async () => {
    seed('Please deploy the release?'); const deps = options();
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ state: 'pending', leader: 1, sent: 0 });
    expect(deps.generate).not.toHaveBeenCalled(); expect(deps.send).not.toHaveBeenCalled();
    expect(readTeammateTexts({ runsDir }).texts).toHaveLength(1);
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ leader: 1 });
    expect(deps.send).not.toHaveBeenCalled();
  });
  it('suppresses acknowledgements and artifact-only updates without generating acknowledgement loops', async () => {
    seed('Acknowledged.'); const deps = options();
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ suppressed: 1 });
    expect(deps.generate).not.toHaveBeenCalled(); expect(deps.send).not.toHaveBeenCalled();
    expect(teammateNeedsReply('Artifact commit abc1234 is ready.')).toBe(false);
    expect(teammateNeedsReply('Ashlr. SLACK PATCH 2/33 (concatenate body after newline):\n+const value = question ? yes : no;')).toBe(false);
    expect(teammateNeedsReply('Please review artifact commit abc1234?')).toBe(true);
  });
  it('keeps drafts on local model failure and never sends secret-shaped model output', async () => {
    seed(); const deps = options(); deps.generate.mockResolvedValue('sk-test-FAKEFAKEFAKE');
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ pending: 1 });
    expect(deps.send).not.toHaveBeenCalled(); expect(state().replies[0]?.state).toBe('drafted');
  });
  it('a definitive pre-send refusal remains a draft and can recover when policy returns', async () => {
    seed(); const deps = options(); deps.send = vi.fn().mockResolvedValueOnce('refused').mockResolvedValue('accepted');
    await runTeammateResponder(cfg, deps); expect(state().replies[0]?.state).toBe('drafted');
    await runTeammateResponder(cfg, deps); expect(deps.generate).toHaveBeenCalledOnce(); expect(deps.send).toHaveBeenCalledTimes(2);
  });
  it('fails closed on malformed receipts without discarding the inbox', async () => {
    seed(); const deps = options();
    writeFileSync(join(runsDir, 'imessage/teammate-replies.json'), '{broken');
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ state: 'unavailable' });
    expect(deps.send).not.toHaveBeenCalled(); expect(readTeammateTexts({ runsDir }).texts).toHaveLength(1);
  });
  it('shutdown cancellation after generation preserves a draft without native side effects', async () => {
    seed(); const controller = new AbortController(); const deps = options();
    deps.generate.mockImplementation(async () => { controller.abort(); return 'Observed work is pending.'; });
    expect(await runTeammateResponder(cfg, { ...deps, signal: controller.signal })).toMatchObject({ pending: 1 });
    expect(deps.send).not.toHaveBeenCalled(); expect(state().replies[0]?.state).toBe('drafted');
  });
  it('caps a pass at three messages and preserves every remaining inbox item', async () => {
    for (let rowid = 1; rowid <= 5; rowid++) recordTeammateText({ rowid, handle: 'agent@example.test', text: 'Please report the current blocker?' }, runsDir, new Date(now()));
    const deps = options(); expect(await runTeammateResponder(cfg, deps)).toMatchObject({ examined: 3, sent: 3 });
    expect(readTeammateTexts({ runsDir }).texts).toHaveLength(2);
  });
  it('sweeps a late-recorded old receipt inside the frozen rowid round', async () => {
    const deps = options();
    deps.approved = (senderId: string) => senderId === senderIdFor('agent@example.test') ? 'agent@example.test' : null;
    for (let rowid = 2; rowid <= 262; rowid++) recordTeammateText({ rowid, handle: 'other@example.test', text: 'Please report the current blocker?' }, runsDir, new Date(now() + rowid));
    // Re-recorded after an intake deferral, the oldest arrival sits behind every
    // newer text in the at-ordered inbox; the round still scans it by rowid.
    recordTeammateText({ rowid: 1, handle: 'agent@example.test', text: 'Please report the current blocker?' }, runsDir, new Date(now() + 1000));
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ sent: 1, pending: 255 });
    expect(deps.send).toHaveBeenCalledOnce();
    expect(state().replies[0]?.state).toBe('sent');
    expect(readTeammateTexts({ runsDir }).texts).toHaveLength(261);
  });
  it('holds arrivals past the frozen round bound until the open round drains', async () => {
    const deps = options();
    for (let rowid = 1; rowid <= 4; rowid++) recordTeammateText({ rowid, handle: 'agent@example.test', text: 'Please report the current blocker?' }, runsDir, new Date(now() + rowid));
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ sent: 3 });
    recordTeammateText({ rowid: 5, handle: 'agent@example.test', text: 'Please report the current blocker?' }, runsDir, new Date(now() + 5));
    // Rowid 5 ranked after the frozen ceiling: it is examined next round, not now.
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ sent: 1 });
    expect(deps.send).toHaveBeenCalledTimes(4);
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ sent: 1 });
    expect(deps.send).toHaveBeenCalledTimes(5);
  });
  const modelResponse = (finish = 'stop', model = 'fast', content = 'The source version is unknown.') => new Response([
    `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  it('uses the canonical local-only transport without tools, redirects, or credentials', async () => {
    const fetcher = vi.fn(async () => modelResponse());
    vi.stubGlobal('fetch', fetcher);
    expect(await generateLocalTeammateReply('Please report?', 'observed context', undefined, { foundry: { localOnly: true } } as AshlrConfig)).toBe('The source version is unknown.');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:8123/v1/chat/completions', expect.objectContaining({ redirect: 'error' }));
    const request = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(request[1].body)) as Record<string, unknown>;
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.max_tokens).toBe(256); expect(body.tools).toBeUndefined();
    expect(request[1].headers).not.toHaveProperty('Authorization');
  });
  it('refuses incomplete or misbound model results without replay', async () => {
    for (const response of [modelResponse('length'), modelResponse('stop', 'other-model')]) {
      const fetcher = vi.fn(async () => response); vi.stubGlobal('fetch', fetcher);
      await expect(generateLocalTeammateReply('private request', 'private context')).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it('cancels before contacting the model when its owner has stopped', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController(); controller.abort();
    await expect(generateLocalTeammateReply('private request', 'private context', controller.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
