import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import { recordTeammateText, readTeammateTexts } from '../src/core/comms/imessage-teammate-inbox.js';
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
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ pending: 1, sent: 0 });
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
  it('uses only the fixed loopback model and refuses redirects for private message generation', async () => {
    const fetcher = vi.fn(async (_url: string, _options: RequestInit) => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'The source version is unknown.' }, finish_reason: 'stop' }] }) }));
    vi.stubGlobal('fetch', fetcher);
    expect(await generateLocalTeammateReply('Please report?', 'observed context')).toBe('The source version is unknown.');
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:8123/v1/chat/completions', expect.objectContaining({ redirect: 'error' }));
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body)) as { chat_template_kwargs: unknown };
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});
