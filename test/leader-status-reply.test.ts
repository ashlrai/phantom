import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const seats = vi.hoisted(() => ({ prompts: [] as string[], raw: '' as string | null }));
vi.mock('../src/core/vision/leader-seat.js', () => ({
  loadDefaultLeaderSeatDeps: async () => ({}),
  planLeaderSeats: async () => seats.raw === null ? { ok: false, reason: 'no seat' } : ({ ok: true, steps: [{
    choice: { seatId: 'devin', engine: 'devin', model: 'm', deep: false }, budget: { timeoutMs: 1000 },
    complete: async (_system: string, user: string) => { seats.prompts.push(user); return seats.raw!; },
  }] }),
}));

import { generateLeaderReply } from '../src/core/agents/leader-network-runtime.js';
import { cleanLeaderReplyText, readLeaderStatusSnapshot, renderLeaderStatus } from '../src/core/comms/leader-status-snapshot.js';

// The Nov 7 reply as it reached Slack: Devin CLI banner, colour codes, and a "nothing to verify" answer.
const NOV7_RAW = '\u001b[2J\u001b[H\u001b[1;36m╭──────────────────╮\u001b[0m\n\u001b[1;36m│\u001b[0m \u001b[1mWelcome to Devin CLI\u001b[0m \u001b[1;36m│\u001b[0m\n\u001b[1;36m╰──────────────────╯\u001b[0m\r\n\u001b]0;devin\u0007\n\n\u001b[32mThe workspace is empty.\u001b[0m\nSpinner |\rSpinner done\n';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); seats.prompts.length = 0; seats.raw = ''; });

function runsDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'leader-status-')); roots.push(root);
  for (const dir of ['queue', 'supervisor', 'leader']) mkdirSync(join(root, dir));
  writeFileSync(join(root, 'queue', 'status.json'), JSON.stringify({ rollup_24h: { by_lane: {
    claude: { merged: 9, median_ttm_s: 1500 }, 'codex-personal': { merged: 3, median_ttm_s: 2400 }, devin: { merged: 0 } } } }));
  writeFileSync(join(root, 'supervisor', 'status-main-guardian.md'), [
    '# Main guardian status (2026-11-09 03:00:00)', '',
    '| repo | branch | sha | state | checked | failing | fixes | nightly |', '|---|---|---|---|---|---|---|---|',
    '| phantom | master | abcdef1 | green | 2026-11-09 03:00:00 | | | |',
    '| locus | main | abcdef2 | green | 2026-11-09 03:00:00 | | | |',
    '| lexicon | main | abcdef3 | red | 2026-11-09 03:00:00 | ci | FIXUP-1 | |',
  ].join('\n'));
  writeFileSync(join(root, 'leader', 'PLAN-LOG.md'), '## 2026-11-09 02:55\n**CEO summary**\n- Release train is steady.\n');
  return root;
}

describe('leader reply cleanup', () => {
  it('turns the Nov 7 raw output into clean text', () => {
    const clean = cleanLeaderReplyText(NOV7_RAW);
    expect(clean).toBe('The workspace is empty.\nSpinner done');
    expect(clean).not.toMatch(/Welcome to Devin|\u001b|╭|\r/);
  });
  it('keeps ordinary replies intact', () => {
    expect(cleanLeaderReplyText('Welcome back. 12 PRs merged.\n\n\n\nAll good.')).toBe('Welcome back. 12 PRs merged.\n\nAll good.');
  });
});

describe('leader status reply', () => {
  const options = (dir: string) => ({ runsDir: dir, now: () => Date.parse('2026-11-09T03:10:00Z') });

  it('summarizes the fixture snapshot with real numbers', async () => {
    const snapshot = await readLeaderStatusSnapshot(options(runsDir()));
    expect(snapshot).toMatchObject({ merged24h: 12, lanes: [{ lane: 'claude', merged: 9, medianTtmS: 1500 }, { lane: 'codex-personal', merged: 3 }, { lane: 'devin', merged: 0 }],
      mains: { known: true, green: 2, red: 1, total: 3, redRepos: ['lexicon'] }, ceo: ['Release train is steady.'] });
    expect(renderLeaderStatus(snapshot)).toContain('Merged PRs in the last 24h: 12');
  });

  it('gives the model the snapshot and returns its cleaned answer', async () => {
    seats.raw = `${NOV7_RAW}12 PRs merged in 24h; 2 of 3 mains green.`;
    const reply = await generateLeaderReply('Phantom status', {} as never, options(runsDir()));
    const prompt = JSON.parse(seats.prompts[0]!) as { statusSnapshot: { merged24h: number; mains: { green: number } } };
    expect(prompt.statusSnapshot).toMatchObject({ merged24h: 12, mains: { green: 2, total: 3 } });
    expect(reply).toBe('The workspace is empty.\nSpinner done\n12 PRs merged in 24h; 2 of 3 mains green.');
  });

  it('answers "Phantom status" from the snapshot when no model is available', async () => {
    seats.raw = null;
    const reply = await generateLeaderReply('Phantom status', {} as never, options(runsDir()));
    expect(reply).toContain('Merged PRs in the last 24h: 12');
    expect(reply).toContain('claude 9 (median 25 min)');
    expect(reply).toContain('Mains green: 2 of 3. Red: lexicon.');
    expect(reply).toContain('CEO summary: Release train is steady.');
  });

  it('says unknown, not zero, when the sources are missing', async () => {
    seats.raw = null;
    const empty = mkdtempSync(join(tmpdir(), 'leader-status-')); roots.push(empty);
    const reply = await generateLeaderReply('Phantom status', {} as never, options(empty));
    expect(reply).toContain('last 24h: unknown');
    expect(reply).toContain('Mains: unknown');
  });
});
