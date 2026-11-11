/**
 * RQ-RENAME-ALIASES-1 — `phm console` is the Phantom name for `phm verse`.
 * (`phm app` was already taken by the desktop update/steer command.) Both
 * forms take the same flags; only the page they open differs (/app/ vs
 * /verse/, which are the same shell). Hermetic: no server is started.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdConsole, cmdVerse, verseUrlFor } from '../src/cli/verse.js';
import { TOP_LEVEL_COMMANDS } from '../src/cli/completions.js';

afterEach(() => vi.restoreAllMocks());

function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  return fn().then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }));
}

describe('phm console / phm verse', () => {
  it('both names are registered commands', () => {
    expect(TOP_LEVEL_COMMANDS).toContain('verse');
    expect(TOP_LEVEL_COMMANDS).toContain('console');
  });

  it('opens /app/ for console and the unchanged /verse/ for verse', () => {
    expect(verseUrlFor('http://127.0.0.1:7777/')).toBe('http://127.0.0.1:7777/verse/');
    expect(verseUrlFor('http://127.0.0.1:7777', 'verse')).toBe('http://127.0.0.1:7777/verse/');
    expect(verseUrlFor('http://127.0.0.1:7777', 'console')).toBe('http://127.0.0.1:7777/app/');
  });

  it('--help works on both and names the command it was run as', async () => {
    const c = await capture(() => cmdConsole(['--help']));
    const v = await capture(() => cmdVerse(['--help']));
    expect(c.code).toBe(0);
    expect(v.code).toBe(0);
    expect(c.out).toContain('phm console');
    expect(c.out).toContain('--no-open');
    expect(v.out).toContain('phm verse');
    expect(v.out).toContain('--no-open');
  });

  it('rejects a bad flag identically, pointing at the right --help', async () => {
    const c = await capture(() => cmdConsole(['--bogus']));
    const v = await capture(() => cmdVerse(['--bogus']));
    expect(c.code).toBe(v.code);
    expect(c.code).toBe(2);
    expect(c.err).toContain('phm console --help');
    expect(v.err).toContain('phm verse --help');
  });

  it('console remote shares the verse remote subcommands', async () => {
    const c = await capture(() => cmdConsole(['remote', 'unknown']));
    const v = await capture(() => cmdVerse(['remote', 'unknown']));
    expect(c.code).toBe(v.code);
    expect(c.code).toBe(2);
  });
});
