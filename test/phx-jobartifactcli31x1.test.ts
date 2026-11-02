import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetJobRead } from '../src/cli/fleet-job-read.js';
import { getFleetJobChanges } from '../src/core/fleet/runs-job-changes.js';
import { getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';
import { getFleetJobText } from '../src/core/fleet/runs-job-texts.js';

let home: string;
let runs: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'fleet-job-artifact-'));
  runs = join(home, '.ashlr-runs');
  await mkdir(runs);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

function cli(...args: string[]) {
  return spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/cli/index.ts'), 'fleet', 'job', ...args], {
    encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH }, timeout: 30_000,
  });
}

describe('fleet job prompt and notes', () => {
  it('reads both real artifacts, scrubs credentials and preserves the JSON projection', async () => {
    await writeFile(join(runs, 'JOB1.prompt'), 'Implement the fix.\ntoken=fake-prompt-credential\n');
    await writeFile(join(runs, 'JOB1.notes.md'), 'Finished.\nBearer fake-notes-credential\n');
    for (const kind of ['prompt', 'notes'] as const) {
      const result = cli('JOB1', `--${kind}`, '--json');
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual(await getFleetJobText('JOB1', kind, { runsDir: runs }));
      expect(result.stdout).not.toContain('fake-prompt-credential');
      expect(result.stdout).not.toContain('fake-notes-credential');
    }
    const prompt = cli('JOB1', '--prompt');
    expect(prompt.status).toBe(0);
    expect(prompt.stdout).toBe('Implement the fix.\ntoken=…\n');
    expect(prompt.stderr).toBe('prompt: ok; truncated: no\n');
    const notes = cli('JOB1', '--notes');
    expect(notes.status).toBe(0);
    expect(notes.stdout).toBe('Finished.\nBearer …\n');
    expect(notes.stderr).toBe('notes: ok; truncated: no\n');
  }, 30_000);

  it('reports missing and unreadable artifacts with failure status in both formats', async () => {
    const missing = cli('JOB1', '--notes');
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toBe('notes: missing; truncated: no\n');
    const missingJson = cli('JOB1', '--notes', '--json');
    expect(missingJson.status).toBe(1);
    expect(JSON.parse(missingJson.stdout)).toEqual(await getFleetJobText('JOB1', 'notes', { runsDir: runs }));
    expect(missingJson.stderr).toBe('');
    await writeFile(join(home, 'outside'), 'do not disclose');
    await symlink(join(home, 'outside'), join(runs, 'JOB1.prompt'));
    const unreadable = cli('JOB1', '--prompt', '--json');
    expect(unreadable.status).toBe(1);
    expect(JSON.parse(unreadable.stdout)).toMatchObject({ state: 'unreadable', text: '' });
    expect(unreadable.stdout).not.toContain('do not disclose');
  }, 30_000);

  it('reports truncation and prints only the bounded text', async () => {
    await writeFile(join(runs, 'JOB1.notes.md'), 'x '.repeat(35 * 1024));
    const result = cli('JOB1', '--notes');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${'x '.repeat(32768)}\n`);
    expect(result.stderr).toBe('notes: ok; truncated: yes\n');
    const json = cli('JOB1', '--notes', '--json');
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(await getFleetJobText('JOB1', 'notes', { runsDir: runs }));
  }, 30_000);

  it('rejects each conflicting selector pair and duplicate selectors before reading', async () => {
    const detail = vi.fn<typeof getFleetJobDetail>();
    const changes = vi.fn<typeof getFleetJobChanges>();
    const text = vi.fn<typeof getFleetJobText>();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const args of [
      ['--prompt', '--notes'], ['--prompt', '--changes'], ['--notes', '--changes'],
      ['--prompt', '--log'], ['--notes', '--log'], ['--prompt', '--prompt'], ['--notes', '--notes'],
    ]) {
      expect(await cmdFleetJobRead(['JOB1', ...args], { detail, changes, text })).toBe(2);
      expect(await cmdFleetJobRead(['--help', ...args], { detail, changes, text })).toBe(2);
    }
    expect(await cmdFleetJobRead(['JOB1', '--prompt', '--path', home], { detail, changes, text })).toBe(2);
    expect(detail).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it('uses the injected text reader and leaves changes output unchanged', async () => {
    const detail = vi.fn<typeof getFleetJobDetail>();
    const changesResult = await getFleetJobChanges('JOB1', { runsDir: runs, homeDir: home });
    const changes = vi.fn(async () => changesResult);
    const text = vi.fn((id: string, kind: 'prompt' | 'notes') => getFleetJobText(id, kind, { runsDir: runs }));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await writeFile(join(runs, 'JOB1.prompt'), 'brief');
    expect(await cmdFleetJobRead(['JOB1', '--prompt', '--json'], { detail, changes, text })).toBe(0);
    expect(text).toHaveBeenCalledExactlyOnceWith('JOB1', 'prompt');
    expect(JSON.parse(String(output.mock.lastCall?.[0]))).toEqual(await getFleetJobText('JOB1', 'prompt', { runsDir: runs }));
    expect(await cmdFleetJobRead(['JOB1', '--changes'], { detail, changes, text })).toBe(0);
    expect(output.mock.lastCall?.[0]).toBe('Fleet job JOB1 changes: missing\nBase: unknown; files: 0; +0 -0\nWorktree evidence unavailable.');
    expect(await cmdFleetJobRead(['JOB1', '--changes', '--json'], { detail, changes, text })).toBe(0);
    expect(JSON.parse(String(output.mock.lastCall?.[0]))).toEqual(changesResult);
    expect(text).toHaveBeenCalledTimes(1);
    expect(detail).not.toHaveBeenCalled();
  });
});
