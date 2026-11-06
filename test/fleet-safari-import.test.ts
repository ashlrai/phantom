import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSafariImport } from '../src/cli/fleet-safari-import.js';

let dir: string;
let out: string[];
const now = (): Date => new Date('2026-11-03T10:00:00.000Z');
const run = (...args: string[]): Promise<number> => cmdFleetSafariImport([...args, '--runs-dir', dir, '--json'], { now });
const needs = (): string => { try { return readFileSync(join(dir, 'NEEDS-MASON.md'), 'utf8'); } catch { return ''; } };
const state = (): { status: string } => JSON.parse(readFileSync(join(dir, 'state', 'safari-import.json'), 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'safari-import-'));
  out = [];
  vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe('fleet safari-import', () => {
  it('plans ask on a fresh dir without writing', async () => {
    expect(await run()).toBe(0);
    expect(JSON.parse(out[0]!).plan).toBe('ask');
    expect(needs()).toBe('');
  });

  it('--apply appends exactly one line and records asked; a second --apply adds none', async () => {
    writeFileSync(join(dir, 'NEEDS-MASON.md'), '- [ ] other item');
    expect(await run('--apply')).toBe(0);
    expect(await run('--apply')).toBe(0);
    const lines = needs().split('\n').filter(l => l.includes('Safari for Phantom'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^- \[ \] Safari for Phantom: .*ashlr fleet safari-import --done$/);
    expect(needs().split('\n')[0]).toBe('- [ ] other item');
    expect(state().status).toBe('asked');
  });

  it('--done gives done and a later --apply adds nothing', async () => {
    await run('--apply');
    const before = needs();
    expect(await run('--done')).toBe(0);
    expect(state().status).toBe('done');
    expect(await run('--apply')).toBe(0);
    expect(needs()).toBe(before);
    out.length = 0;
    await run();
    expect(JSON.parse(out[0]!).plan).toBe('done');
  });

  it('refuses malformed state with exit 1 and leaves it byte-identical', async () => {
    mkdirSync(join(dir, 'state'));
    const file = join(dir, 'state', 'safari-import.json');
    for (const bad of ['{not json', '{"v":2,"status":"asked"}', '{"v":1,"status":"maybe"}']) {
      writeFileSync(file, bad);
      for (const flag of ['--apply', '--done', '']) {
        expect(await run(...(flag ? [flag] : []))).toBe(1);
        expect(readFileSync(file, 'utf8')).toBe(bad);
      }
    }
    expect(needs()).toBe('');
  });

  it('rejects bad args with exit 2', async () => {
    expect(await cmdFleetSafariImport(['--bogus'])).toBe(2);
    expect(await cmdFleetSafariImport(['--apply', '--done', '--runs-dir', dir])).toBe(2);
    expect(await cmdFleetSafariImport(['--help'])).toBe(0);
  });

  it('core never touches browser stores or credentials', () => {
    const src = readFileSync(new URL('../src/core/fleet/safari-import-ask.ts', import.meta.url), 'utf8');
    for (const word of ['Cookies', 'Login Data', 'find-generic-password', 'Keychain']) expect(src).not.toContain(word);
  });
});
