import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('..', import.meta.url));
let home: string;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'phm-recut-busgraph61-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

/** Real dispatch through src/cli/index.ts: phm bus -> cmdBus -> createBusMailbox. */
function child(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'bus', ...args], {
    // The fleet board import graph needs a generous cold-compile budget.
    cwd: repo, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr'), NO_COLOR: '1' },
  });
}

describe('phm bus mailbox dispatch (RQ-PHX-RECUTBUSGRAPH61)', () => {
  it('routes send/inbox/ack through the real CLI to the durable mailbox', () => {
    const sent = child(['send', '--from', 'codex-cmp', '--to', 'fleet', '--id', 'recut-1',
      '--body', '{"task":"review"}', '--priority', 'P1', '--json']);
    expect(sent.status).toBe(0);
    expect(sent.stderr).toBe('');
    expect(JSON.parse(sent.stdout)).toEqual({ ok: true, id: 'recut-1', replayed: false });

    const inbox = child(['inbox', '--to', 'fleet', '--json']);
    expect(inbox.status).toBe(0);
    const page = JSON.parse(inbox.stdout);
    expect(page.ok).toBe(true);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({
      id: 'recut-1', from: 'codex-cmp', to: 'fleet', priority: 'P1', body: { task: 'review' },
    });

    const ack = child(['ack', 'recut-1', '--to', 'fleet', '--json']);
    expect(ack.status).toBe(0);
    expect(JSON.parse(ack.stdout)).toEqual({ ok: true, id: 'recut-1', acknowledged: true, replayed: false });
    expect(JSON.parse(child(['inbox', '--to', 'fleet', '--json']).stdout).messages).toEqual([]);
  });

  it('accepts --json before the mailbox verb', () => {
    const result = child(['--json', 'send', '--from', 'a', '--to', 'b', '--body', '{}', '--id', 'flag-first']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, id: 'flag-first', replayed: false });
    expect(JSON.parse(child(['inbox', '--to', 'b', '--json']).stdout).messages[0].id).toBe('flag-first');
  });

  it('keeps the shared task board on phm bus --help and thread|task verbs', () => {
    const help = child(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('phm bus thread create');
    // A board verb must reach the board, not the mailbox usage error.
    const board = child(['thread', 'list', '--json']);
    expect(board.stdout).not.toContain('Usage: phm bus <send|inbox|ack>');
  });

  it('mailbox usage stays reachable through its own verbs', () => {
    const help = child(['send', '--help', '--json']);
    expect(help.status).toBe(0);
    expect(JSON.parse(help.stdout).usage).toContain('phm bus <send|inbox|ack>');
    expect(existsSync(join(home, '.ashlr', 'bus'))).toBe(false);
  });
});
