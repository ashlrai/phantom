/**
 * Readiness round 8: agent-facing CLI gaps found by driving `phm` from an
 * empty HOME. Each case failed before its fix.
 *
 *  - `playbook new|edit --file <missing>` printed a raw ENOENT.
 *  - `inbox show|approve|reject|submit|automerge <unknown> --json` refused
 *    without a next step.
 *  - `vision show --json` looked up a spec named "--json".
 *  - `benchmark --compare-reports A B --json` printed help and exited 2.
 *  - `automations templates --json` ignored --json and printed text.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAutomationsCli } from '../src/cli/automations.js';
import { runBenchmarkCli } from '../src/cli/benchmark.js';
import { cmdInbox } from '../src/cli/inbox.js';
import { runPlaybookCli } from '../src/cli/playbook.js';
import { cmdVision } from '../src/cli/vision.js';
import { AUTOMATION_TEMPLATES } from '../src/core/automations/index.js';
import { fakeLanes, isolateAshlrHome } from './helpers/automations-fakes.js';

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'phm-r8-')); });
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('playbook new/edit --file with an unreadable file', () => {
  it('names the file and the way forward instead of a raw ENOENT, and saves nothing', async () => {
    const missing = join(scratch, 'missing.md');
    const out: string[] = [];
    const err: string[] = [];
    const save = vi.fn();
    const code = await runPlaybookCli(['new', 'my-play', '--file', missing], {
      save, out: (l) => out.push(l), err: (l) => err.push(l), readStdin: () => null,
      edit: () => { throw new Error('editor must not open'); },
    });
    expect(code).toBe(1);
    expect(save).not.toHaveBeenCalled();
    const text = err.join('\n');
    expect(text).toContain(`Could not read --file ${missing}`);
    expect(text).toContain('no such file');
    expect(text).not.toContain('ENOENT');
    expect(text).toMatch(/omit --file/);
  });

  it('edit reports the same refusal for an existing playbook', async () => {
    const missing = join(scratch, 'nope.md');
    const err: string[] = [];
    const save = vi.fn();
    const current = { version: 1, source: 'id: fix-issue\n' } as never;
    const code = await runPlaybookCli(['edit', 'fix-issue', '--file', missing], {
      get: async () => current, save, out: () => {}, err: (l) => err.push(l), readStdin: () => null,
    });
    expect(code).toBe(1);
    expect(save).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain(`Could not read --file ${missing}`);
  });
});

describe('inbox refusals for an unknown proposal id carry a next step', () => {
  it.each([
    ['show'], ['approve', '--yes'], ['reject'], ['submit', '--yes'], ['automerge'],
  ])('inbox %s <unknown> --json', async (verb, ...extra) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await cmdInbox([verb, 'no-such-proposal', ...extra, '--json']);
    expect(code).toBe(1);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    const body = JSON.parse(lines[0]!) as { ok: boolean; error: string; next?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('Proposal not found: no-such-proposal');
    expect(body.next).toMatch(/phm inbox --status all/);
  });

  it('human output prints the next step on stderr', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdInbox(['show', 'no-such-proposal'])).toBe(1);
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/phm inbox --status all/);
  });
});

describe('vision show --json', () => {
  it('prints the spec as one JSON object instead of looking up a spec named --json', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdVision(['show', '--json'])).toBe(0);
    expect(error).not.toHaveBeenCalled();
    const spec = JSON.parse(log.mock.calls.map((c) => String(c[0])).join('\n')) as { id: string; northStar: string };
    expect(spec.id).toBe('ecosystem');
    expect(typeof spec.northStar).toBe('string');
  });

  it('an unknown spec with --json refuses with {ok:false,error,next} on stdout', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdVision(['show', 'nonexistent-spec-zzz', '--json'])).toBe(1);
    const body = JSON.parse(String(log.mock.calls[0]?.[0])) as { ok: boolean; error: string; next: string };
    expect(body).toMatchObject({ ok: false, error: "spec 'nonexistent-spec-zzz' not found" });
    expect(body.next).toMatch(/phm vision show/);
  });

  it('refuses an unknown flag as usage (exit 2) instead of treating it as a spec id', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdVision(['show', '--jsno'])).toBe(2);
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain("unknown option '--jsno'");
    expect(await cmdVision(['show', 'a', 'b'])).toBe(2);
  });
});

describe('benchmark --compare-reports accepts --json', () => {
  it.each([
    [['--compare-reports', 'base.json', 'head.json', '--json']],
    [['--compare-reports', '--json', 'base.json', 'head.json']],
  ])('%j compares the two reports', async (args) => {
    const compare = vi.fn(() => ({ output: '{"status":"compared"}', exitCode: 0 as const }));
    const out = vi.fn();
    const err = vi.fn();
    expect(await runBenchmarkCli(args, { loadRunner: vi.fn(), loadComparator: async () => ({ compareReportsCli: compare }), out, err })).toBe(0);
    expect(compare).toHaveBeenCalledWith(['--compare-reports', 'base.json', 'head.json']);
    expect(out).toHaveBeenCalledWith('{"status":"compared"}');
    expect(err).not.toHaveBeenCalled();
  });

  it('a repeated --json is still a usage refusal before loading anything', async () => {
    const loadComparator = vi.fn();
    expect(await runBenchmarkCli(['--compare-reports', 'a', 'b', '--json', '--json'], { loadRunner: vi.fn(), loadComparator, out: vi.fn(), err: vi.fn() })).toBe(2);
    expect(loadComparator).not.toHaveBeenCalled();
  });
});

describe('automations templates --json', () => {
  let restore: () => void;
  beforeEach(() => { restore = isolateAshlrHome(); });
  afterEach(() => restore());

  const run = (out: string[], err: string[], ...argv: string[]) => runAutomationsCli(argv, {
    engine: { ...fakeLanes().deps, decider: null },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    readFile: async () => { throw new Error('unused'); },
  });

  it('prints the templates as one JSON object', async () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(await run(out, err, 'templates', '--json')).toBe(0);
    const body = JSON.parse(out.join('\n')) as { templates: Array<{ id: string; name: string; blurb: string }> };
    expect(body.templates.map((t) => t.id)).toEqual(AUTOMATION_TEMPLATES.map((t) => t.id));
    expect(err).toEqual([]);
  });

  it('refuses flags and arguments templates does not take', async () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(await run(out, err, 'templates', '--enable')).toBe(2);
    expect(await run(out, err, 'templates', 'extra')).toBe(2);
    expect(err.join('\n')).toContain('templates takes');
  });
});
