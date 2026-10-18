/**
 * Roadmap index discovery for `phm roadmap`.
 *
 * docs/MILESTONE-CONTRACT.md promised that the default index names are tried
 * in order, but resolveRoadmapPath only ever used `roadmap.md`. A repo with
 * `ROADMAP.md` on a case-sensitive filesystem got a raw
 * "ENOENT: no such file or directory, open '.../roadmap.md'" with no next step.
 * Now `ROADMAP.md` is found, and a missing index names the files looked for
 * and how to point at one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRoadmap, resolveRoadmapPath } from '../src/core/goal-loop/parse.js';
import { cmdRoadmap } from '../src/cli/roadmap.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ashlr-roadmap-index-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('roadmap index discovery', () => {
  it('finds an upper-case ROADMAP.md when roadmap.md is absent', () => {
    writeFileSync(join(dir, 'ROADMAP.md'), '- [M0](M0-bootstrap.md)\n');
    const index = parseRoadmap(dir);
    expect(index.path.endsWith('ROADMAP.md')).toBe(true);
    expect(index.milestones.map((m) => m.id)).toEqual(['M0']);
  });

  it('never treats README.md as the roadmap by default', () => {
    writeFileSync(join(dir, 'README.md'), '- [Guide](docs/guide.md)\n');
    expect(resolveRoadmapPath(dir).endsWith('README.md')).toBe(false);
    expect(() => parseRoadmap(dir)).toThrow(/No roadmap index/);
  });

  it('a missing index names what was looked for and the next step', () => {
    let message = '';
    try {
      parseRoadmap(dir);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toMatch(/ENOENT/);
    expect(message).toContain('roadmap.md, ROADMAP.md');
    expect(message).toContain('docs/MILESTONE-CONTRACT.md');
    expect(message).toContain('--roadmap <file>');
  });

  it('a missing explicit --roadmap file says which file', () => {
    expect(() => parseRoadmap(dir, 'plan.md')).toThrow(/Roadmap file not found: .*plan\.md/);
  });

  it('`roadmap status --json` answers a missing index with JSON carrying the next step', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdRoadmap(['status', '--dir', dir, '--json'])).toBe(1);
    const payload = JSON.parse(out.join('\n')) as { error: string };
    expect(payload.error).toMatch(/No roadmap index/);
    expect(payload.error).toContain('--roadmap <file>');
  });
});
