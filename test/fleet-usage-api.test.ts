import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cmdResourceUsage } from '../src/cli/resource-usage.js';

let dir: string;
const saved = process.env.ASHLR_RUNS_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fleet-usage-cli-')); process.env.ASHLR_RUNS_DIR = dir; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); if (saved === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = saved; });

async function capture(args: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try { return { code: await cmdResourceUsage(args), out: lines.join('\n') }; } finally { console.log = orig; }
}

it('prints fleet-usage.v1 JSON with unknown lanes when nothing exists', async () => {
  const { code, out } = await capture(['--json']);
  expect(code).toBe(0);
  const json = JSON.parse(out);
  expect(json.schema).toBe('fleet-usage.v1');
  expect(json.lanes.map((l: { lane: string }) => l.lane)).toContain('gemini');
});

it('prints a table by default and usage on --help', async () => {
  expect((await capture([])).out).toContain('unknown');
  expect((await capture(['--help'])).out).toContain('phm resources usage');
});

it('rejects unknown arguments', async () => {
  expect((await capture(['--bogus'])).code).toBe(2);
});
