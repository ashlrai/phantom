import { existsSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { probeUp, tickRefused } = vi.hoisted(() => ({
  probeUp: vi.fn(async (id: string, url: string) => ({
    id,
    url,
    up: true,
    models: ['test-model'],
  })),
  tickRefused: vi.fn(async () => ({
    ran: false,
    reason: 'activation-refused' as const,
    dryRun: false,
  })),
}));

vi.mock('../src/core/providers.js', () => ({ probeEndpoint: probeUp }));
vi.mock('../src/core/daemon/loop.js', () => ({ tick: tickRefused }));

import { cmdDemo } from '../src/cli/demo.js';
import { makeDemoContext } from '../src/cli/demo-sandbox.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

/**
 * Names (never contents) of whatever survived or reappeared under a removed
 * demo home, with each entry's age relative to the moment cmdDemo returned, so
 * a failure identifies the writer instead of only reporting that one exists.
 */
function describeResidue(root: string, returnedAt: number): string {
  const entries: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entries.length >= 40) return;
      const path = join(dir, entry.name);
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(path);
      entries.push(`${name}${entry.isDirectory() ? '/' : ''} (mtime ${Math.round(stat.mtimeMs - returnedAt)}ms)`);
      if (entry.isDirectory()) walk(path, name);
    }
  };
  try {
    const stat = fs.lstatSync(root);
    walk(root, '');
    return ` (home mtime ${Math.round(stat.mtimeMs - returnedAt)}ms after cmdDemo returned; ` +
      `entries: ${entries.length > 0 ? entries.join(', ') : 'none'})`;
  } catch (err) {
    return ` (residue unreadable: ${(err as NodeJS.ErrnoException).code ?? 'unknown'})`;
  }
}

let fixture: H1Fixture | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
const retainedPaths: string[] = [];

beforeEach(() => {
  expect.hasAssertions();
  fixture = makeFixture();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  probeUp.mockClear();
  tickRefused.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const path of retainedPaths.splice(0)) fs.rmSync(path, { recursive: true, force: true });
  fixture?.cleanup();
  fixture = undefined;
});

describe('M461 live demo activation refusal', () => {
  it('returns failure, reports the refusal, and still disposes the isolated context', async () => {
    const homeBefore = process.env.HOME;

    const code = await cmdDemo(['--json']);
    const returnedAt = Date.now();

    expect(code).toBe(1);
    expect(process.env.HOME).toBe(homeBefore);
    expect(tickRefused).toHaveBeenCalledOnce();
    expect(errorSpy).not.toHaveBeenCalled();

    const output = logSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    const transcript = JSON.parse(output) as {
      ok: boolean;
      liveModel: boolean;
      error: string;
      cleanupError?: string;
      steps: Array<{ step: string }>;
    };
    expect(transcript).toMatchObject({
      ok: false,
      liveModel: true,
      error: 'activation-refused',
    });
    expect(transcript.steps.at(-1)?.step).toBe('tick');

    const isolatedHome = output.match(/tmp HOME at ([^ ]+)/)?.[1];
    expect(isolatedHome).toBeDefined();
    const homeSurvived = existsSync(isolatedHome!);
    expect(
      homeSurvived,
      transcript.cleanupError ??
        `owned demo home must be removed${homeSurvived ? describeResidue(isolatedHome!, returnedAt) : ''}`,
    ).toBe(false);
    expect(transcript.cleanupError).toBeUndefined();
  });

  it('reports a real removal refusal after cleanup and still restores HOME', async () => {
    const homeBefore = process.env.HOME;
    const realRemove = fs.rmSync;
    vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (String(path).includes(`ashlr-h8-demo-home-${process.pid}-`)) {
        retainedPaths.push(String(path));
        throw Object.assign(new Error('private removal detail must not enter the trace'), { code: 'EACCES' });
      }
      realRemove(path, options);
    });
    syncBuiltinESMExports();
    expect(await cmdDemo(['--json'])).toBe(1);
    const output = logSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(JSON.parse(output)).toMatchObject({
      ok: false, error: 'activation-refused',
      cleanupError: 'temporary cleanup incomplete (home: EACCES)',
    });
    expect(output).not.toContain('private removal detail');
    expect(retainedPaths).toHaveLength(1);
    expect(existsSync(retainedPaths[0]!)).toBe(true);
    expect(process.env.HOME).toBe(homeBefore);
  });

  it('detects a remover that returns without deleting, and disposal stays idempotent', () => {
    const homeBefore = process.env.HOME;
    const context = makeDemoContext();
    const realRemove = fs.rmSync;
    const removal = vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (path === context.home) { retainedPaths.push(context.home); return; }
      realRemove(path, options);
    });
    syncBuiltinESMExports();
    const result = context.dispose();
    expect(result).toMatchObject({ cleanupComplete: false,
      reason: 'temporary cleanup incomplete (home: still present)' });
    expect(existsSync(context.home)).toBe(true);
    expect(existsSync(context.repoDir)).toBe(false);
    expect(process.env.HOME).toBe(homeBefore);
    const calls = removal.mock.calls.length;
    expect(context.dispose()).toBe(result);
    expect(removal.mock.calls.length).toBe(calls);
  });

  it('treats explicitly kept directories as intentional and restores the environment', () => {
    const homeBefore = process.env.HOME;
    const context = makeDemoContext({ keep: true });
    retainedPaths.push(context.home, context.repoDir);
    expect(context.dispose().cleanupComplete).toBe(true);
    expect(existsSync(context.home)).toBe(true);
    expect(existsSync(context.repoDir)).toBe(true);
    expect(process.env.HOME).toBe(homeBefore);
  });
});
