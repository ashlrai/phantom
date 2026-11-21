/** `phm host load --by-tree`: fixture text in, whole-tree attribution out. Nothing here runs ps or reads the real home. */
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { cmdHost } from '../src/cli/host.js';
import { attributeProcessTrees, parseProcessList, readHostLoadReport, type ProcessRow, type TreeRootMatcher } from '../src/core/fleet/host-load.js';
import { createFleetMemoryApi, VERSE_FLEET_HOST_LOAD_PATH } from '../src/core/verse/fleet-memory-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const row = (pid: number, ppid: number, cpu: number, command: string, memoryKb = 1024): ProcessRow => ({ pid, ppid, cpu, memoryKb, command });
const job = (name: string, pid: number): TreeRootMatcher => ({ name: `job ${name}`, fleet: true, pid });
const by = (trees: ReturnType<typeof attributeProcessTrees>, name: string) => trees.roots.find(r => r.name === name)!;

describe('attributeProcessTrees', () => {
  it('sums a three-level tree and names the busiest children', () => {
    const trees = attributeProcessTrees([
      row(1, 0, 1, '/sbin/launchd'),
      row(10, 1, 2, 'worker run'), row(11, 10, 50, 'npm run typecheck'), row(12, 11, 150, 'tsgo --noEmit'),
      row(13, 10, 20, 'vitest run'), row(14, 13, 5, 'node child'),
    ], [job('one', 10)]);
    expect(by(trees, 'job one')).toEqual({
      name: 'job one', fleet: true, cpuPercent: 227, memoryMb: 5, descendants: 4, processes: 5,
      topCommands: [{ command: 'tsgo', cpuPercent: 150 }, { command: 'npm (typecheck)', cpuPercent: 50 }, { command: 'vitest', cpuPercent: 20 }],
    });
    expect(trees).toMatchObject({ fleetCpuPercent: 227, totalCpuPercent: 228, fleetShare: 0.996 });
    expect(trees.summary).toBe("The fleet's own jobs and their children use 100% of CPU; the top tree is job one (tsgo).");
  });

  it('never shows argv: only the program name and a fixed work word', () => {
    const trees = attributeProcessTrees([
      row(10, 1, 2, 'worker run'), row(11, 10, 50, '/usr/local/bin/node /tmp/job/vitest run --password=hunter2 --out /secret/place'),
    ], [job('one', 10)]);
    expect(by(trees, 'job one').topCommands).toEqual([{ command: 'node (vitest)', cpuPercent: 50 }]);
    expect(JSON.stringify(trees)).not.toMatch(/hunter2|secret|place/);
  });

  it('puts an orphan, and everything else outside a root, under unattributed', () => {
    const trees = attributeProcessTrees([row(10, 1, 10, 'worker'), row(50, 999, 30, 'lonely thing'), row(60, 50, 5, 'its child')], [job('one', 10)]);
    expect(by(trees, 'unattributed')).toMatchObject({ fleet: false, cpuPercent: 35, descendants: 2 });
    expect(trees.roots.reduce((sum, r) => sum + r.cpuPercent, 0)).toBe(trees.totalCpuPercent);
  });

  it('survives a pid cycle without looping or dropping rows', () => {
    const trees = attributeProcessTrees([row(10, 11, 10, 'a'), row(11, 10, 20, 'b'), row(12, 11, 1, 'c')], [job('one', 99)]);
    expect(by(trees, 'unattributed')).toMatchObject({ cpuPercent: 31, descendants: 3 });
    const rooted = attributeProcessTrees([row(10, 11, 10, 'a'), row(11, 10, 20, 'b')], [job('one', 10)]);
    expect(by(rooted, 'job one')).toMatchObject({ cpuPercent: 30, descendants: 1 });
  });

  it('counts a repeated pid once', () => {
    const trees = attributeProcessTrees([row(10, 1, 5, 'worker'), row(11, 10, 40, 'build'), row(11, 10, 40, 'build')], [job('one', 10)]);
    expect(by(trees, 'job one')).toMatchObject({ cpuPercent: 45, descendants: 1 });
    expect(trees.totalCpuPercent).toBe(45);
  });

  it('keeps two fleet roots apart and shares CPU across the host', () => {
    const trees = attributeProcessTrees([
      row(10, 1, 30, 'worker'), row(11, 10, 30, 'build'), row(20, 1, 10, 'worker'),
      row(30, 1, 100, '/Applications/Chrome.app/Contents/MacOS/Chrome'), row(31, 30, 20, 'helper'),
    ], [job('one', 10), job('two', 20), { name: 'Chrome', fleet: false, command: /\/Chrome\.app\// }]);
    expect(trees.roots.map(r => [r.name, r.cpuPercent, r.descendants])).toEqual([['Chrome', 120, 1], ['job one', 60, 1], ['job two', 10, 0]]);
    expect(trees.fleetShare).toBe(0.368);
    expect(trees.summary).toBe("The fleet's own jobs and their children use 37% of CPU; the top tree is job one (build).");
  });

  it('shows unknown for an empty list', () => {
    const trees = attributeProcessTrees([], [job('one', 10)]);
    expect(trees).toMatchObject({ fleetShare: 'unknown', roots: [], totalCpuPercent: 0 });
    expect(trees.summary).toContain('unknown');
  });
});

describe('parseProcessList', () => {
  it('reads long commands and odd spacing, and skips the header', () => {
    const long = `/usr/local/bin/node ${'--flag=value '.repeat(60)}run   x`;
    const rows = parseProcessList(`  PID  PPID  %CPU   RSS COMMAND\n\t 12    1   3.5   2048   ${long}  \n   7 \t 12  0.0  10 plain\ngarbage line\n`);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ pid: 12, ppid: 1, cpu: 3.5, memoryKb: 2048, command: long.trimEnd() });
    expect(rows[1]).toEqual({ pid: 7, ppid: 12, cpu: 0, memoryKb: 10, command: 'plain' });
    expect(parseProcessList(null)).toEqual([]);
  });
});

const psText = '  PID  PPID  %CPU  RSS COMMAND\n 1 0 1.0 100 /sbin/launchd\n 400 1 10.0 2048 worker\n 401 400 90.0 4096 npm run typecheck\n';
const deps = (out: string[]) => ({
  ps: async () => psText, jobRoots: () => [{ jobId: 'RQ-ONE', pid: 400 }], load: () => ({ load1: 40, load5: null, load15: null, cores: 10, ratio: 4 }),
  now: () => 0, write: (text: string) => { out.push(text); },
});

describe('host load --by-tree', () => {
  it('prints JSON with trees and fleet share', async () => {
    const out: string[] = [];
    expect(await cmdHost(['load', '--by-tree', '--json'], deps(out))).toBe(0);
    const json = JSON.parse(out.join('')) as { schema: string; groups: unknown[]; trees: { fleetShare: number; roots: { name: string; topCommands: unknown[] }[]; summary: string } };
    expect(json.schema).toBe('host.load.v1');
    expect(json.groups.length).toBeGreaterThan(0);
    expect(json.trees.fleetShare).toBe(0.99);
    expect(json.trees.roots[0]).toMatchObject({ name: 'job RQ-ONE', fleet: true, cpuPercent: 100, descendants: 1 });
    expect(json.trees.summary).toBe("The fleet's own jobs and their children use 99% of CPU; the top tree is job RQ-ONE (typecheck).");
  });

  it('opens the human output with one plain sentence, and plain mode has no trees', async () => {
    const out: string[] = [];
    expect(await cmdHost(['load', '--by-tree'], deps(out))).toBe(0);
    expect(out.join('').split('\n')[0]).toMatch(/^The fleet's own jobs and their children use 99% of CPU/);
    const plain: string[] = [];
    await cmdHost(['load', '--json'], deps(plain));
    expect(JSON.parse(plain.join(''))).not.toHaveProperty('trees');
    expect(await cmdHost(['load', '--by-tree', '--by-tree'], deps([]))).toBe(2);
  });

  it('serves the same report from the typed route with ?by=tree', async () => {
    const api = createFleetMemoryApi({ readHostLoad: opts => readHostLoadReport({ ...deps([]), ps: async () => psText }, opts) });
    const call = async (url: string) => {
      const res = Object.assign(new PassThrough(), { writeHead() { return this; }, setHeader() { return this; } }) as unknown as ServerResponse;
      const chunks: Buffer[] = [];
      (res as unknown as PassThrough).on('data', (c: Buffer) => chunks.push(c));
      await api({ cfg: {} } as VerseApiContext, Object.assign(new PassThrough(), { url, method: 'GET' }) as IncomingMessage, res, VERSE_FLEET_HOST_LOAD_PATH, 'GET');
      (res as unknown as PassThrough).end();
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as { trees?: { fleetShare: number } };
    };
    expect((await call(`${VERSE_FLEET_HOST_LOAD_PATH}?by=tree`)).trees?.fleetShare).toBe(0.99);
    expect((await call(VERSE_FLEET_HOST_LOAD_PATH)).trees).toBeUndefined();
  });
});
