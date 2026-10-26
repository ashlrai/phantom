import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({
  createPr: vi.fn(async () => ({ ok: true, url: 'https://github.invalid/pr/1', detail: 'created' })),
  listPrs: vi.fn(() => []),
  listIssues: vi.fn(() => []),
  githubStatus: vi.fn(() => ({ ci: 'unknown' })),
}));

vi.mock('../src/core/integrations/github.js', () => effects);

import { cmdGh } from '../src/cli/gh.js';

let stdout = '';
let stderr = '';

beforeEach(() => {
  for (const fn of Object.values(effects)) fn.mockClear();
  stdout = '';
  stderr = '';
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { stdout += parts.join(' ') + '\n'; });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { stderr += String(chunk); return true; });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function nothingCalled(): void {
  expect(effects.createPr).not.toHaveBeenCalled();
  expect(effects.listPrs).not.toHaveBeenCalled();
  expect(effects.listIssues).not.toHaveBeenCalled();
  expect(effects.githubStatus).not.toHaveBeenCalled();
}

describe('gh <verb> --help never runs the verb', () => {
  it.each([
    [['pr', 'create', '--title', 'Fix it', '--yes', '--help']],
    [['pr', 'create', '--help']],
    [['pr', '--help']],
    [['pr', 'list', '-h']],
    [['issue', '--help']],
    [['ci', '-h']],
  ])('%j prints usage and calls GitHub for nothing', async (args) => {
    await expect(cmdGh(args)).resolves.toBe(0);
    nothingCalled();
    expect(stdout).toContain('Subcommands:');
  });
});

describe('gh pr create refuses unknown arguments', () => {
  it('a mistyped flag with --yes is refused instead of creating a PR', async () => {
    await expect(cmdGh(['pr', 'create', '--title', 'Fix it', '--yes', '--dry-run'])).resolves.toBe(2);
    nothingCalled();
    expect(stderr).toContain('unknown argument');
  });

  it('a stray word is refused', async () => {
    await expect(cmdGh(['pr', 'create', '--title', 'Fix it', 'extra', '--yes'])).resolves.toBe(2);
    nothingCalled();
  });

  it('a well-formed create with --yes still creates the PR', async () => {
    await expect(cmdGh(['pr', 'create', '--title', 'Fix it', '--draft', '--yes', '--json'])).resolves.toBe(0);
    expect(effects.createPr).toHaveBeenCalledWith(process.cwd(), expect.objectContaining({ title: 'Fix it', draft: true }));
  });
});
