import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_RECOVERY_MAX_ITEMS,
  CLAUDE_RECOVERY_RECURRING,
  claudeRecoveryBacklogItems,
  foldClaudeRecoveryCells,
} from '../src/core/improve/claude-recovery-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);
const NOW = Date.now();
const ago = (hours: number): string => new Date(NOW - hours * HOUR).toISOString();

/** A claude_recovery row in the producer's exact shape (dispatchd metric() adds ts). */
const recoveryRow = (parent: string, hoursAgo: number, opts: {
  reason?: string; repo?: string | null; child?: string | null; extra?: Record<string, unknown>;
} = {}): string => J({
  event: 'claude_recovery',
  parent_job: parent,
  job: opts.child === undefined ? `${parent}-CR1` : opts.child,
  reason: opts.reason ?? 'claude_exit_1_empty_repeated',
  evidence: [
    { ts: ago(hoursAgo + 1), lane: 'claude', exit_code: 1, empty: true, repo: opts.repo === undefined ? 'phantom' : opts.repo },
    { ts: ago(hoursAgo), lane: 'claude', exit_code: 1, empty: true, repo: opts.repo === undefined ? 'phantom' : opts.repo },
  ],
  done: false,
  source: `/runs/prompts/${parent}.md`,
  line: `${parent}-CR1\tphantom\tclaude\twork\t/runs/prompts/${parent}-CR1.md\t{}`,
  ts: ago(hoursAgo),
  ...opts.extra,
});

describe('foldClaudeRecoveryCells', () => {
  it('groups rows by recorded reason with distinct-parent counts and repo tallies', () => {
    const cells = foldClaudeRecoveryCells([
      recoveryRow('RQ-A', 5, { repo: 'phantom' }),
      recoveryRow('RQ-B', 4, { repo: 'phantom' }),
      recoveryRow('RQ-C', 3, { repo: 'lexicon' }),
      recoveryRow('RQ-D', 2, { reason: 'other_recovery', repo: 'phantom' }),
    ].join('\n'), NOW, 72 * HOUR);
    expect(cells).toHaveLength(2);
    const main = cells[0]!;
    expect(main.reason).toBe('claude_exit_1_empty_repeated');
    expect(main.count).toBe(3);
    expect(main.rows).toBe(3);
    expect(main.repos).toEqual([{ text: 'phantom', count: 2 }, { text: 'lexicon', count: 1 }]);
    expect(main.parents).toEqual(['RQ-A', 'RQ-B', 'RQ-C']);
    expect(main.children).toEqual(['RQ-A-CR1', 'RQ-B-CR1', 'RQ-C-CR1']);
    expect(main.firstSeen).toBe(new Date(NOW - 5 * HOUR).toISOString());
    expect(main.lastSeen).toBe(new Date(NOW - 3 * HOUR).toISOString());
    expect(cells[1]!.reason).toBe('other_recovery');
    expect(cells[1]!.count).toBe(1);
  });

  it('counts a duplicated parent row once and never quotes unsafe ids or paths', () => {
    const cells = foldClaudeRecoveryCells([
      recoveryRow('RQ-DUP', 5),
      recoveryRow('RQ-DUP', 4),
      J({ event: 'claude_recovery', parent_job: 'bad id\nforged', job: 'x-CR1', reason: 'r', ts: ago(3) }),
      J({ event: 'claude_recovery', parent_job: 'RQ-NOTS', reason: 'r', ts: 'not a date' }),
      J({ event: 'claude_recovery', job: 'RQ-NOPARENT', reason: 'r', ts: ago(3) }),
      'not json at all',
    ].join('\n'), NOW, 72 * HOUR);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.count).toBe(1);
    expect(cells[0]!.rows).toBe(2);
    expect(cells[0]!.parents).toEqual(['RQ-DUP']);
  });

  it('drops rows outside the window, future rows and non-recovery events', () => {
    const cells = foldClaudeRecoveryCells([
      recoveryRow('RQ-OLD', 100),
      recoveryRow('RQ-FUTURE', -2),
      J({ event: 'launch', job: 'RQ-L', lane: 'claude', ts: ago(1) }),
      J({ type: 'claude_recovery', parent_job: 'RQ-TYPE', reason: 'r', ts: ago(2) }),
    ].join('\n'), NOW, 72 * HOUR);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.parents).toEqual(['RQ-TYPE']);
  });

  it('reads repo labels only from bounded evidence receipts and marks missing reasons', () => {
    const cells = foldClaudeRecoveryCells([
      J({
        event: 'claude_recovery', parent_job: 'RQ-E1', job: 'RQ-E1-CR1',
        evidence: [{ repo: 'phantom' }, { repo: 'phantom' }, { repo: 42 }, 'junk', null],
        ts: ago(4),
      }),
      J({ event: 'claude_recovery', parent_job: 'RQ-E2', job: 'RQ-E2-CR1', ts: ago(3) }),
      J({ event: 'claude_recovery', parent_job: 'RQ-E3', job: 'RQ-E3-CR1', reason: 'x'.repeat(300), ts: ago(2) }),
    ].join('\n'), NOW, 72 * HOUR);
    expect(cells).toHaveLength(2);
    const unrecorded = cells.find((c) => c.reason === 'unrecorded reason')!;
    expect(unrecorded.count).toBe(2);
    expect(unrecorded.repos).toEqual([{ text: 'phantom', count: 1 }]);
    const long = cells.find((c) => c.reason !== 'unrecorded reason')!;
    expect(long.reason.length).toBeLessThanOrEqual(160);
    expect(long.reason).not.toContain('\n');
  });
});

describe('claudeRecoveryBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'claude-recovery-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  async function runsDir(name: string, ledger?: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    if (ledger !== undefined) await writeFile(join(dir, 'metrics', 'jobs.jsonl'), ledger.join('\n') + '\n');
    return dir;
  }

  it('emits one item for a recurring reason cell and validates it', async () => {
    const dir = await runsDir('runs-hit', [
      recoveryRow('RQ-C1', 30), recoveryRow('RQ-C2', 20), recoveryRow('RQ-C3', 10),
      J({ event: 'finish', job: 'RQ-OTHER', lane: 'claude', ts: ago(5) }),
    ]);
    const items = await claudeRecoveryBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'claude-recovery' });
    expect(item!.id).toMatch(/^fleet-claude-recovery-[0-9a-f]{16}$/);
    expect(item!.title).toContain('auto-recovery');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('RQ-C1');
    expect(item!.prompt).toContain('RQ-C1-CR1');
    expect(item!.prompt).toContain('claude_exit_1_empty_repeated');
    expect(item!.prompt).toContain('claude_recovery');
    expect(item!.prompt).toContain('claude-recoveries.json');
    expect(item!.prompt).toContain('no-change');
    // Local path fields (row.source, row.line) never reach the prompt.
    expect(item!.prompt).not.toContain('/runs/prompts/');
    expect(item!.prompt).not.toContain('.md');
  });

  it('emits nothing below the recurring bar of distinct parents', async () => {
    const dir = await runsDir('runs-quiet', [
      recoveryRow('RQ-Q1', 30), recoveryRow('RQ-Q2', 20), recoveryRow('RQ-Q1', 10),
    ]);
    const items = await claudeRecoveryBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toEqual([]);
    expect(CLAUDE_RECOVERY_RECURRING).toBe(3);
  });

  it('splits cells by recorded reason and honours the limit', async () => {
    const dir = await runsDir('runs-split', [
      recoveryRow('RQ-S1', 30), recoveryRow('RQ-S2', 25), recoveryRow('RQ-S3', 20),
      recoveryRow('RQ-T1', 15, { reason: 'other_failure' }), recoveryRow('RQ-T2', 14, { reason: 'other_failure' }),
      recoveryRow('RQ-T3', 13, { reason: 'other_failure' }),
    ]);
    const items = await claudeRecoveryBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
    expect(items.map((i) => i.prompt).join('\n')).toContain('other_failure');
    expect(await claudeRecoveryBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW), limit: 1 })).toHaveLength(1);
    expect(CLAUDE_RECOVERY_MAX_ITEMS).toBeGreaterThan(0);
  });

  it('emits nothing for a missing ledger or another repository', async () => {
    const empty = await runsDir('runs-empty');
    expect(await claudeRecoveryBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW) })).toEqual([]);
    expect(await claudeRecoveryBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    const dir = await runsDir('runs-repo', [
      recoveryRow('RQ-P1', 30), recoveryRow('RQ-P2', 20), recoveryRow('RQ-P3', 10),
    ]);
    expect(await claudeRecoveryBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await claudeRecoveryBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW) })).toHaveLength(1);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = await runsDir('runs-stable', [
      recoveryRow('RQ-S1', 30), recoveryRow('RQ-S2', 20), recoveryRow('RQ-S3', 10),
    ]);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) };
    const first = await claudeRecoveryBacklogItems(opts);
    const second = await claudeRecoveryBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('states a truncated tail as a lower bound in the prompt', async () => {
    const dir = await runsDir('runs-trunc', []);
    // Pad well past the byte bound so the tail read truncates; the pad
    // is one invalid line the tail drops, leaving the three whole rows.
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'),
      'x'.repeat(32 * 1024) + '\n' + [
        recoveryRow('RQ-T1', 30), recoveryRow('RQ-T2', 20), recoveryRow('RQ-T3', 10),
      ].join('\n') + '\n');
    const items = await claudeRecoveryBacklogItems({
      repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW), ledgerLimit: 16 * 1024,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('appends claude-recovery items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), [
      recoveryRow('RQ-D1', 30), recoveryRow('RQ-D2', 20), recoveryRow('RQ-D3', 10),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const recItems = first.items.filter((i) => i.id.startsWith('fleet-claude-recovery-'));
    expect(recItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(recItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-claude-recovery-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-claude-recovery-'))).toHaveLength(1);
  });
});
