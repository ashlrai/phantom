/**
 * RQ-PHX-REPLYCLEANORIGINAL238S: exact-preservation evidence for original PR
 * #4268 (RQ-REPLYCLEANN9Q8). The original made generateLeaderReply feed the
 * model a real status snapshot, strip CLI chrome (banner, ANSI/OSC, box
 * drawing, carriage-return redraws) from seat output, keep meaningful answer
 * text, and fall back to an honest grounded render when no model or no
 * evidence exists. Master already carries that work plus newer rules (queue
 * rollup freshness, injectable seat deps, reply batching); this suite drives
 * the CURRENT contract — injectable LeaderReplySeatModule, temp runs state,
 * deterministic clock — and asserts only the still-missing original
 * behaviors. Complements test/leader-status-reply.test.ts (Nov 7 fixture),
 * leader-rollup-freshness-147.test.ts (stale-tick rule) and
 * leader-status-partial-rollup-142.test.ts (incomplete rollups).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateLeaderReply, type LeaderReplySeatModule } from '../src/core/agents/leader-network-runtime.js';
import { cleanLeaderReplyText, renderLeaderStatus } from '../src/core/comms/leader-status-snapshot.js';

const NOW_MS = Date.parse('2026-11-12T12:00:00Z');
const seats = { prompts: [] as string[], raw: '' as string | null, planOk: true };
const seat = {
  loadDefaultLeaderSeatDeps: async () => ({}),
  planLeaderSeats: async () => !seats.planOk ? { ok: false, reason: 'no seat' } : ({ ok: true, steps: [{
    choice: { seatId: 'devin', engine: 'devin', model: 'm', deep: false }, budget: { timeoutMs: 1000 },
    complete: async (_system: string, user: string) => { seats.prompts.push(user); return seats.raw; },
  }] }),
} as unknown as LeaderReplySeatModule;

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  seats.prompts.length = 0; seats.raw = ''; seats.planOk = true;
});

function runsDir(withQueue = true): string {
  const root = mkdtempSync(join(tmpdir(), 'leader-clean-238s-')); roots.push(root);
  for (const dir of ['queue', 'supervisor', 'leader']) mkdirSync(join(root, dir));
  if (withQueue) {
    writeFileSync(join(root, 'queue', 'status.json'), JSON.stringify({
      last_tick: new Date(NOW_MS - 10_000).toISOString(),
      rollup_24h: { merged: 12, median_ttm_s: 1500, by_lane: {
        claude: { merged: 9, median_ttm_s: 1500 }, 'codex-personal': { merged: 3, median_ttm_s: 2400 }, devin: { merged: 0 } } },
    }));
  }
  writeFileSync(join(root, 'supervisor', 'status-main-guardian.md'), [
    '# Main guardian status (2026-11-12 11:59:00)', '',
    '| repo | branch | sha | state | checked | failing | fixes | nightly |', '|---|---|---|---|---|---|---|---|',
    '| phantom | master | abcdef1 | green | 2026-11-12 11:59:00 | | | |',
    '| locus | main | abcdef2 | red | 2026-11-12 11:59:00 | ci | FIXUP-1 | |',
  ].join('\n'));
  writeFileSync(join(root, 'leader', 'PLAN-LOG.md'), '## 2026-11-12 11:58\n**CEO summary**\n- Release train is steady.\n');
  return root;
}

const options = (dir: string) => ({ runsDir: dir, now: () => NOW_MS });
const reply = (text: string, dir: string) => generateLeaderReply(text, {} as never, options(dir), { seat });

describe('original #4268 reply cleanup', () => {
  it('strips ST-terminated OSC, box chrome and banners; a carriage return keeps only the final redraw', () => {
    const raw = '\x1b]0;devin session\x1b\\\n'
      + '╭──────────────────────╮\n'
      + '│ Welcome to Claude Code │\n'
      + '╰──────────────────────╯\r\n'
      + 'type /help for commands\n'
      + '\x1b[1;36m12 PRs merged.\x1b[0m Mains: 1 of 2 green.\n'
      + 'Progress 10%\rProgress 100%\n'
      + 'Done.\n';
    const clean = cleanLeaderReplyText(raw);
    expect(clean).toBe('12 PRs merged. Mains: 1 of 2 green.\nProgress 100%\nDone.');
    expect(clean).not.toMatch(/\x1b|╭|╰|Welcome to Claude|\/help|Progress 10%/);
  });

  it('keeps meaningful multi-line answer content and collapses only excess blank runs', () => {
    expect(cleanLeaderReplyText('First point.\n\nSecond point.\n\n\n\nThird point.')).toBe('First point.\n\nSecond point.\n\nThird point.');
    expect(cleanLeaderReplyText('   \n\nReal answer.\n')).toBe('Real answer.');
  });
});

describe('original #4268 status reply through the current seat seam', () => {
  it('hands the model real queue, guardian and journal evidence and returns the cleaned answer', async () => {
    seats.raw = '\x1b]0;t\x1b\\\n╭─╮\n│ Welcome to Devin CLI │\n╰─╯\r\n'
      + 'Codex lanes lead; lexicon main is red.\nSpinner |\rSpinner done\n';
    const text = await reply('Phantom status', runsDir());
    const prompt = JSON.parse(seats.prompts[0]!) as { request: string; statusSnapshot: {
      merged24h: number; medianTtmS: number; lanes: { lane: string; merged: number }[];
      mains: { green: number; red: number; total: number; redRepos: string[] }; ceo: string[] } };
    expect(prompt.request).toBe('Phantom status');
    expect(prompt.statusSnapshot).toMatchObject({
      merged24h: 12, medianTtmS: 1500,
      lanes: [{ lane: 'claude', merged: 9 }, { lane: 'codex-personal', merged: 3 }, { lane: 'devin', merged: 0 }],
      mains: { known: true, green: 1, red: 1, total: 2, redRepos: ['locus'] },
      ceo: ['Release train is steady.'],
    });
    expect(text).toBe('Codex lanes lead; lexicon main is red.\nSpinner done');
    expect(text).not.toMatch(/\x1b|╭|Welcome to Devin|Spinner \|/);
  });

  it('falls back to the grounded snapshot render when no seat can answer a status ask', async () => {
    seats.planOk = false;
    const text = await reply('Phantom status', runsDir());
    expect(text).toContain('Merged PRs in the last 24h: 12');
    expect(text).toContain('claude 9 (median 25 min)');
    expect(text).toContain('Mains green: 1 of 2. Red: locus.');
    expect(text).toContain('CEO summary: Release train is steady.');
    expect(seats.prompts).toHaveLength(0);
  });

  it('returns null rather than inventing a reply for a non-status ask with no seat', async () => {
    seats.planOk = false;
    expect(await reply('what is your name', runsDir())).toBeNull();
  });

  it('answers unknown, never zero, when every evidence source is missing', async () => {
    seats.planOk = false;
    const empty = mkdtempSync(join(tmpdir(), 'leader-clean-empty-')); roots.push(empty);
    const text = await reply('Phantom status', empty);
    expect(text).toContain('last 24h: unknown');
    expect(text).toContain('Mains: unknown');
    expect(text).not.toMatch(/last 24h: 0|Mains green: 0 of 0/);
  });

  it.each([
    ['oversized', 'x'.repeat(6001)],
    ['secret-bearing', `token ghp_${'a'.repeat(36)}`],
  ])('rejects %s model output and returns the honest fallback instead', async (_label, raw) => {
    seats.raw = raw;
    const text = await reply('Phantom status', runsDir());
    expect(text).toContain('Merged PRs in the last 24h: 12');
    expect(text).not.toContain('ghp_');
    expect(text!.length).toBeLessThan(2000);
  });
});
