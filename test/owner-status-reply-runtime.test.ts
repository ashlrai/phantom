import { describe, expect, it, vi } from 'vitest';
import { composeOwnerStatusReply } from '../src/core/agents/owner-status-reply.js';
import type { WorkBoardResult } from '../src/core/comms/work-board.js';

const now = new Date('2026-11-13T20:27:00Z'); // 15:27 ET
const brief = async () => 'Morning leader brief\nShipped (last 12h): 2 fake PRs';
const RUNTIME = 'Runtime: fake-host (1.0.0, source 1.0.0), fleet state 1m old · Slack LIVE · iMessage LIVE';
const emptyBoard = (): WorkBoardResult => ({ items: [], inbox: 'ok', truncated: false });

describe('composeOwnerStatusReply runtime line', () => {
  it('puts the runtime line second, directly under the heading', async () => {
    const runtime = vi.fn(async () => RUNTIME);
    const reply = await composeOwnerStatusReply('/x', now, { brief, board: emptyBoard, runtime });
    const lines = reply.split('\n');
    expect(lines[0]).toBe('Phantom status, 15:27 ET');
    expect(lines[1]).toBe(RUNTIME);
    expect(lines[2]).toBe('Shipped (last 12h): 2 fake PRs');
    expect(lines[3]).toContain('Work items as of 15:27 ET');
    expect(runtime).toHaveBeenCalledWith(now);
  });

  it('a throwing runtime seam leaves the no-runtime reply byte-identical', async () => {
    const baseline = await composeOwnerStatusReply('/x', now, { brief, board: emptyBoard });
    const throwing = await composeOwnerStatusReply('/x', now, { brief, board: emptyBoard, runtime: async () => { throw new Error('synthetic runtime failure'); } });
    expect(throwing).toBe(baseline);
    expect(throwing).not.toContain('Runtime:');
  });

  it('a blank seam result adds no line at all', async () => {
    const reply = await composeOwnerStatusReply('/x', now, { brief, board: emptyBoard, runtime: async () => '' });
    expect(reply.split('\n')[1]).toBe('Shipped (last 12h): 2 fake PRs');
  });

  it('keeps only the first line of a multi-line seam result', async () => {
    const reply = await composeOwnerStatusReply('/x', now, { brief, board: emptyBoard, runtime: async () => `${RUNTIME}\nextra` });
    expect(reply.split('\n')[1]).toBe(RUNTIME);
    expect(reply).not.toContain('extra');
  });

  it('drops work-board lines before the runtime line when over 1500 chars', async () => {
    // 24-char heading + ~90-char runtime + 1350-char digest ≈ 1466; the board
    // line pushes it over, so the board line goes and the runtime line stays.
    const digest = 'd'.repeat(1350);
    const reply = await composeOwnerStatusReply('/x', now, { brief: async () => `Morning leader brief\n${digest}`, board: emptyBoard, runtime: async () => RUNTIME });
    expect(reply.length).toBeLessThanOrEqual(1500);
    expect(reply).toContain('Runtime: fake-host');
    expect(reply).toContain(digest);
    expect(reply).not.toContain('Work items');
  });

  it('drops the runtime line next, then truncates the digest last', async () => {
    const digest = 'd'.repeat(1480);
    const reply = await composeOwnerStatusReply('/x', now, { brief: async () => `Morning leader brief\n${digest}`, board: emptyBoard, runtime: async () => RUNTIME });
    expect(reply).toHaveLength(1500);
    expect(reply.endsWith('…')).toBe(true);
    expect(reply).not.toContain('Runtime:');
    expect(reply.startsWith('Phantom status, 15:27 ET\ndddd')).toBe(true);
  });

  it('drops the runtime line when it is the piece that overflows', async () => {
    const digest = 'd'.repeat(1460);
    const reply = await composeOwnerStatusReply('/x', now, { brief: async () => `Morning leader brief\n${digest}`, board: emptyBoard, runtime: async () => RUNTIME });
    expect(reply.length).toBeLessThanOrEqual(1500);
    expect(reply).not.toContain('Runtime:');
    expect(reply).not.toContain('Work items');
    expect(reply).toContain(digest);
  });
});
