import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetStuck } from '../src/cli/fleet-stuck.js';
import { cmdFleetYield } from '../src/cli/fleet-yield.js';
import { cmdQueueCoalesce } from '../src/cli/queue-coalesce.js';

describe('fleet throughput guide command examples', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  it('reports unavailable stuck and yield inputs as unknown with their actual exit codes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'throughput-'));
    dirs.push(dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetStuck(['--events', join(dir, 'missing-events'), '--ready', join(dir, 'missing-ready'), '--json'])).toBe(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ count: null, jobs: [], sources: { events: 'missing' } });
    expect(await cmdFleetYield(['--since', '24h', '--metrics', join(dir, 'missing-metrics'), '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ known: false, launches: 0, window_hours: 24 });
  });

  it('plans eligible jobs and preserves exclusions without changing files on dry run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'throughput-'));
    dirs.push(dir);
    const path = join(dir, 'router-queue.md');
    const input = [
      '- READY RQ-ONE-1 (P1, pool=work, tier=work, repo=demo, size<=100): First task',
      '- READY RQ-TWO-1 (P1, pool=work, tier=work, repo=demo, size<=200): Second task',
      '- READY RQ-URGENT-1 (P0, pool=work, tier=work, repo=demo, size<=10): Urgent',
      '- READY RQ-LARGE-1 (P1, pool=work, tier=work, repo=demo): Unknown size',
      '',
    ].join('\n');
    await writeFile(path, input);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdQueueCoalesce([path, '--json'])).toBe(0);
    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(report).toMatchObject({ applied: false, out: null, batches: [{ replaces: ['RQ-ONE-1', 'RQ-TWO-1'] }] });
    expect(report.kept).toEqual(expect.arrayContaining([{ id: 'RQ-URGENT-1', reason: 'P0' }, { id: 'RQ-LARGE-1', reason: 'not small' }]));
    expect(await readdir(dir)).toEqual(['router-queue.md']);
    expect(await readFile(path, 'utf8')).toBe(input);
  });
});

// Read the guide itself so newly documented flags cannot silently drift.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFile(join(root, path), 'utf8');

describe('C530 throughput documentation matches shipped sources', () => {
  it('documents only registered commands and supported flags', async () => {
    const guide = await read('docs/fleet-throughput.md');
    const fleet = await read('src/cli/fleet-subcommand-registry.ts');
    const queue = await read('src/cli/queue.ts');
    const sections = [...guide.matchAll(/## `phm ([^`]+)`[^\n]*\n([\s\S]*?)(?=\n## |$)/g)];
    expect(sections.map(section => section[1])).toEqual(['fleet stuck', 'fleet yield', 'queue coalesce']);
    for (const section of sections) {
      const command = section[1]!;
      const source = await read(`src/cli/${command.replace(' ', '-')}.ts`);
      const verb = command.split(' ')[1]!;
      expect(command.startsWith('fleet') ? fleet : queue).toContain(verb);
      const flags = [...new Set(section[2]!.match(/--[a-z][a-z-]*/g))];
      expect(flags.length).toBeGreaterThan(0);
      for (const flag of flags) expect(source, `${command} does not support ${flag}`).toContain(flag);
    }
  });

  it('backs every documented runtime file path with a reader or writer', async () => {
    const guide = await read('docs/fleet-throughput.md');
    const yieldSource = await read('src/cli/fleet-yield.ts');
    const coalesceSource = await read('src/cli/queue-coalesce.ts');
    const runtimePaths = [...new Set(guide.match(/(?:metrics\/jobs\.jsonl|router-queue(?:\.original)?\.md|prompts\/<batch id>\.md)/g))];
    expect(runtimePaths.sort()).toEqual(['metrics/jobs.jsonl', 'prompts/<batch id>.md', 'router-queue.md', 'router-queue.original.md']);
    expect(yieldSource).toContain("'metrics', 'jobs.jsonl'");
    for (const path of runtimePaths.filter(path => path.startsWith('router-queue'))) {
      expect(coalesceSource).toContain(`'${path}'`);
    }
    expect(coalesceSource).toContain("join(out, 'prompts', `${batch.id}.md`)");
  });
});
