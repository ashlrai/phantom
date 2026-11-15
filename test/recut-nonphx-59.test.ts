/**
 * RQ-PHX-RECUTNONPHX59 (recut of #4552): Leader replies texted back over
 * iMessage, proven through the real `phm imessage replies` entry point and the
 * real guarded transport. Only `osascript` itself is faked, so nothing leaves
 * the machine; every guard between the CLI and Messages.app is the shipped code.
 *
 * Fixture handles are plainly fake and never real numbers or addresses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const osascript = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (file: string, args: string[], _opts: unknown, cb: (err: Error | null, out: string, errOut: string) => void) => {
      osascript(file, args);
      cb(null, '', '');
      return {} as never;
    },
  };
});

const { cmdIMessage } = await import('../src/cli/imessage.js');
const { sendLeaderReplies } = await import('../src/core/comms/imessage-leader-replies.js');

const MASON = 'mason-fake@example.invalid';
const OTHER = 'not-mason-fake@example.invalid';

let runs = '';
let savedRuns: string | undefined;
let savedPlatform: PropertyDescriptor | undefined;
let logs: string[] = [];

function writeConfig(comms: Record<string, unknown>): void {
  const dir = join(homedir(), '.ashlr');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ comms: { enabled: true, imessageHandle: MASON, ...comms } }));
}

function outbox(text: string, at: string): void {
  mkdirSync(join(runs, 'leader'), { recursive: true });
  appendFileSync(join(runs, 'leader', 'MASON-OUTBOX.md'), `## ${at}\n${text}\n\n`);
}

async function replies(): Promise<{ code: number; json: Record<string, unknown> }> {
  logs = [];
  const code = await cmdIMessage(['replies', '--json']);
  return { code, json: JSON.parse(logs.at(-1) ?? '{}') as Record<string, unknown> };
}

/** Every handle the faked osascript was asked to text. */
const textedHandles = (): string[] => osascript.mock.calls
  .map((call) => String((call[1] as string[])[1]).match(/participant "([^"]+)"/)?.[1] ?? '');

beforeEach(() => {
  runs = mkdtempSync(join(tmpdir(), 'recut-nonphx-59-'));
  savedRuns = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = runs;
  // The transport only shells out on macOS; pin it so the real guard path runs on any CI host.
  savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  osascript.mockClear();
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedPlatform) Object.defineProperty(process, 'platform', savedPlatform);
  if (savedRuns === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = savedRuns;
  rmSync(join(homedir(), '.ashlr', 'config.json'), { force: true });
  rmSync(runs, { recursive: true, force: true });
});

describe('phm imessage replies (recut of #4552)', () => {
  it('is a dry run unless comms.leaderRepliesSend is true: nothing leaves the Mac', async () => {
    writeConfig({});
    outbox('Build is green.', '2026-11-09T10:00:00Z');
    const r = await replies();
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ state: 'dry-run', dryRun: true, waiting: 1, sent: 0 });
    expect(osascript).not.toHaveBeenCalled();
  });

  it('live: baselines history, then texts each new reply once and only to the configured handle', async () => {
    // A second handle on the intake allowlist must never become a destination.
    writeConfig({ leaderRepliesSend: true, imessageAllow: [MASON, OTHER] });
    outbox('Old history line.', '2026-11-09T09:00:00Z');

    const first = await replies();
    expect(first.json).toMatchObject({ state: 'baselined', sent: 0 });
    expect(osascript).not.toHaveBeenCalled();

    outbox('Queue is clear.', '2026-11-09T11:00:00Z');
    const second = await replies();
    expect(second.code).toBe(0);
    expect(second.json).toMatchObject({ state: 'sent', sent: 1, failed: 0, waiting: 0 });
    expect(osascript).toHaveBeenCalledTimes(1);
    expect(osascript.mock.calls[0]![0]).toBe('osascript');
    expect(textedHandles()).toEqual([MASON]);
    expect(String((osascript.mock.calls[0]![1] as string[])[1])).toContain('Queue is clear.');

    const third = await replies();
    expect(third.json).toMatchObject({ sent: 0, waiting: 0 });
    expect(osascript).toHaveBeenCalledTimes(1); // never twice

    const ledgerFile = join(runs, 'imessage', 'leader-sent.jsonl');
    expect(readFileSync(ledgerFile, 'utf8')).not.toContain('Queue is clear.'); // hashes only
    expect(statSync(ledgerFile).mode & 0o777).toBe(0o600);
  });

  it('an unverified destination is refused before the transport is touched', async () => {
    writeConfig({ leaderRepliesSend: true });
    outbox('Anything.', '2026-11-09T10:00:00Z');
    // Even a caller that hands the pass someone else's handle cannot reach them.
    const cfg = { comms: { enabled: true, imessageHandle: MASON, leaderRepliesSend: true } } as never;
    await sendLeaderReplies(cfg, { runsDir: runs }); // baseline
    outbox('Second reply.', '2026-11-09T12:00:00Z');
    const r = await sendLeaderReplies(cfg, {
      runsDir: runs,
      send: async (text, c, _to) => (await import('../src/core/integrations/imessage.js')).sendIMessage(text, c, OTHER),
    });
    expect(r).toMatchObject({ state: 'sent', sent: 0, failed: 1 });
    expect(osascript).not.toHaveBeenCalled();
  });

  it('a concurrent live pass is busy and sends nothing', async () => {
    writeConfig({ leaderRepliesSend: true });
    const { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } = await import('../src/core/fleet/local-store-lock.js');
    const dir = join(runs, 'imessage');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const held = acquireLocalStoreLockWithOutcome(join(dir, 'leader-replies.lock'), 0, { anchorPath: dir });
    expect(held.state).toBe('acquired');
    try {
      outbox('Racing reply.', '2026-11-09T10:00:00Z');
      const r = await replies();
      expect(r.code).toBe(0);
      expect(r.json).toMatchObject({ state: 'busy', sent: 0 });
      expect(osascript).not.toHaveBeenCalled();
    } finally {
      if (held.state === 'acquired') releaseLocalStoreLock(held.lock);
    }
  });
});
