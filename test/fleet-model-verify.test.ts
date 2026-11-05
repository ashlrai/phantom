import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetModelVerify } from '../src/cli/fleet-model-verify.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { verifyFleetModels } from '../src/core/fleet/model-verify.js';

let root: string, registryPath: string;
const now = () => Date.parse('2026-11-05T00:00:00Z');
const entry = (verified = '2026-11-05') => ({ id: 'documented-model', provider: 'provider', docs_url: 'https://example.com/models', verified });
const opts = () => ({ registryPath, now });
const models = (value: unknown) => writeFile(join(root, 'models.json'), JSON.stringify(value));
const registry = (value: unknown) => writeFile(registryPath, JSON.stringify(value));
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'model-verify-'));
  registryPath = join(root, 'registry.json');
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await models({ codex: 'documented-model' });
  await registry([entry()]);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it('uses ASHLR_RUNS_DIR, accepts fresh IDs, all aliases and effort metadata without writing', async () => {
  await models({ codex: 'documented-model', ...Object.fromEntries(['haiku', 'sonnet', 'opus', 'auto', 'fast', 'strong'].map(id => [id, id])), 'effort.codex.work': 'high' });
  const before = await readFile(join(root, 'models.json'), 'utf8');
  expect(await cmdFleetModelVerify([], opts())).toBe(0);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('current documentation'));
  expect(await readFile(join(root, 'models.json'), 'utf8')).toBe(before);
});
it('lists every unknown and stale assignment in JSON and plain output', async () => {
  await models({ a: 'unknown', b: 'unknown', c: 'documented-model' });
  await registry([entry('2026-10-05')]);
  expect(await cmdFleetModelVerify(['--json'], opts())).toBe(1);
  const report = JSON.parse(vi.mocked(console.log).mock.calls[0][0]);
  expect(report.issues).toEqual([{ key: 'a', model: 'unknown', reason: 'unregistered' }, { key: 'b', model: 'unknown', reason: 'unregistered' }, { key: 'c', model: 'documented-model', reason: 'stale' }]);
  expect(await cmdFleetModelVerify([], opts())).toBe(1);
  expect(console.log).toHaveBeenCalledWith('"c": "documented-model" — stale');
});
it('accepts exactly 30 days and rejects one millisecond older', async () => {
  await registry([entry('2026-10-06')]);
  expect((await verifyFleetModels(opts())).issues).toEqual([]);
  expect((await verifyFleetModels({ ...opts(), now: () => now() + 1 })).issues[0].reason).toBe('stale');
});
it.each([null, [], { a: null }, { a: '' }, { a: 42 }])('fails invalid model input %j', async value => {
  await models(value);
  expect(await cmdFleetModelVerify(['--json'], opts())).toBe(1);
});
it.each([null, {}, [entry('invalid')], [entry('2026-02-30')], [entry('2026-11-06')], [entry(), entry()], [{ ...entry(), docs_url: 'http://example.com' }]])('fails invalid registry %j', async value => {
  await registry(value);
  expect(await cmdFleetModelVerify(['--json'], opts())).toBe(1);
  expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0]).error).toBeTruthy();
});
it.each(['models.json', 'registry.json'])('fails missing and malformed %s without echoing contents', async name => {
  await rm(join(root, name));
  expect(await cmdFleetModelVerify(['--json'], opts())).toBe(1);
  await writeFile(join(root, name), 'private-invalid-content');
  expect(await cmdFleetModelVerify(['--json'], opts())).toBe(1);
  expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('private-invalid-content');
});
it('loads the shipped registry and generated CLI verb', async () => {
  const seed: Array<{ id: string; verified: string }> = JSON.parse(await readFile(new URL('../docs/model-registry.json', import.meta.url), 'utf8'));
  const latest = seed.reduce((a, b) => a.verified > b.verified ? a : b);
  await models({ codex: latest.id });
  expect(await cmdFleetModelVerify(['--json'], { now: () => Date.parse(latest.verified) })).toBe(0);
  expect((await FLEET_SUBCOMMAND_LOADERS['model-verify']()).cmdFleetModelVerify).toBe(cmdFleetModelVerify);
  expect(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).files).toContain('docs/model-registry.json');
});
it('rejects oversized files and symlinks', async () => {
  await writeFile(join(root, 'models.json'), ' '.repeat(1024 * 1024 + 1));
  expect(await cmdFleetModelVerify(['--json'], opts())).toBe(1);
  await rm(join(root, 'models.json'));
  await symlink(registryPath, join(root, 'models.json'));
  expect(await cmdFleetModelVerify(['--json'], opts())).toBe(1);
});
it('provides help and rejects unsupported arguments', async () => {
  expect(await cmdFleetModelVerify(['--help'])).toBe(0);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('ASHLR_RUNS_DIR'));
  expect(await cmdFleetModelVerify(['--typo'])).toBe(2);
  expect(await cmdFleetModelVerify(['unexpected'])).toBe(2);
  expect(await cmdFleetModelVerify(['--json', '--json'])).toBe(2);
});
