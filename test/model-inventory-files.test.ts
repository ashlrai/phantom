import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runModelInventory } from '../src/core/resources/model-inventory.js';

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'model-inventory-TEST-')); homes.push(path);
  await writeFile(join(path, 'model-inventory.json'), JSON.stringify({ enabled: true })); return path;
}
function dependencies() {
  return { verifyListener: vi.fn(async () => true), admit: vi.fn(async () => false), fetch: vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/ps') return new Response(JSON.stringify({ models: [] }));
    return new Response(JSON.stringify({ models: [] }));
  }) as typeof fetch };
}
describe('model inventory fleet persistence', () => {
  it('preserves fleet and sibling resources while writing a versioned inventory block', async () => {
    const path = await home(); const deps = dependencies();
    await writeFile(join(path, 'fleet.json'), JSON.stringify({ schemaVersion: 2, resources: { cpu: 8 }, workers: ['TEST-worker'] }));
    const result = await runModelInventory(path, deps);
    expect(JSON.parse(await readFile(join(path, 'fleet.json'), 'utf8'))).toEqual({ schemaVersion: 2,
      resources: { cpu: 8, models: result }, workers: ['TEST-worker'] });
    expect(result).toMatchObject({ schemaVersion: 1, promptTokens: 512, repetitions: 3, models: [] });
    expect(await readdir(path)).toEqual(expect.arrayContaining(['fleet.json', 'model-inventory.json']));
    expect((await readdir(path)).some(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toBe(false);
  });
  it('refuses an existing lock before any API contact', async () => {
    const path = await home(); const deps = dependencies(); await mkdir(join(path, 'model-inventory.lock'));
    await expect(runModelInventory(path, deps)).rejects.toThrow(); expect(deps.fetch).not.toHaveBeenCalled();
    expect(await readdir(path)).toContain('model-inventory.lock');
  });
  it.each(['[]', 'null', '{"resources":[]}'])('preserves malformed fleet data %s', async content => {
    const path = await home(); await writeFile(join(path, 'fleet.json'), content);
    await expect(runModelInventory(path, dependencies())).rejects.toThrow('Cannot read fleet');
    expect(await readFile(join(path, 'fleet.json'), 'utf8')).toBe(content);
    expect(await readdir(path)).not.toContain('model-inventory.lock');
  });
  it('does not contact engines without explicit opt-in', async () => {
    const path = await home(); const deps = dependencies(); await writeFile(join(path, 'model-inventory.json'), '{}');
    await expect(runModelInventory(path, deps)).rejects.toThrow('disabled'); expect(deps.fetch).not.toHaveBeenCalled();
  });
});
