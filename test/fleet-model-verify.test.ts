import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetModelVerify } from '../src/cli/fleet-model-verify.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { verifyFleetModels, verifyModelRegistry } from '../src/core/fleet/model-verify.js';
import { cmdModels } from '../src/cli/models.js';

let root: string, registryPath: string;
const now = () => Date.parse('2026-11-05T00:00:00Z');
const entry = (verified = '2026-11-05') => ({ id: 'documented-model', provider: 'openai', verified_source: 'https://developers.openai.com/api/docs/models', verified_at: verified, status: 'verified' as const });
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
it.each([null, {}, [entry('invalid')], [entry('2026-02-30')], [entry('2026-11-06')], [entry(), entry()], [{ ...entry(), verified_source: 'http://example.com' }]])('fails invalid registry %j', async value => {
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
  const seed: Array<{ id: string; verified_at: string | null }> = JSON.parse(await readFile(new URL('../docs/model-registry.json', import.meta.url), 'utf8'));
  const latest = seed.reduce((a, b) => (a.verified_at ?? '') > (b.verified_at ?? '') ? a : b);
  await models({ codex: latest.id });
  expect(await cmdFleetModelVerify(['--json'], { now: () => Date.parse(latest.verified_at!) })).toBe(0);
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

it('reports every status, unknown evidence and stable ID/key order; only current choices fail', async () => {
  const rows = [
    { ...entry(), id: 'z-retired', status: 'retired' },
    { ...entry(), id: 'b-unknown', status: 'unverified', verified_at: null, verified_source: null },
    { ...entry('2026-10-21'), id: 'a-stale' }, entry(),
  ];
  await registry(rows);
  await models({ z: 'documented-model', a: 'a-stale', 'mode.a-stale': 'normal', 'effort.z': 'high' });
  expect(await cmdModels(['verify'], opts())).toBe(0);
  const first = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0]);
  expect(first.results.map((r: { id: string }) => r.id)).toEqual(['a-stale', 'b-unknown', 'documented-model', 'z-retired']);
  expect(first.results[0]).toMatchObject({ status: 'verified', age_days: 15, needs_recheck: true });
  expect(first.results[1]).toMatchObject({ status: 'unverified', age_days: null, verified_source: null, needs_recheck: true });
  expect(first.results[3].status).toBe('retired');
  expect(first.current_choices.map((r: { key: string }) => r.key)).toEqual(['a', 'z']);
  await registry(rows.reverse());
  expect(await verifyModelRegistry(opts())).toEqual(first);
  for (const model of ['b-unknown', 'z-retired', 'unregistered', 'auto']) {
    await models({ codex: model });
    expect(await cmdModels(['verify', '--json'], opts())).toBe(1);
  }
  expect(await cmdModels(['verify', '--text'], opts())).toBe(1);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('age unknown'));
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('re-check needed'));
});
it('flags evidence strictly older than fourteen days without retiring it', async () => {
  await registry([entry('2026-10-22')]);
  expect((await verifyModelRegistry(opts())).results[0]).toMatchObject({ age_days: 14, needs_recheck: false });
  expect((await verifyModelRegistry({ ...opts(), now: () => now() + 1 })).results[0]).toMatchObject({ status: 'verified', needs_recheck: true });
});
it('fails closed on missing choices or invalid evidence and keeps JSON errors safe', async () => {
  await rm(join(root, 'models.json'));
  expect(await cmdModels(['verify'], opts())).toBe(1);
  expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])).toMatchObject({ ok: false, results: [expect.objectContaining({ id: 'documented-model' })], error: expect.stringContaining('unknown') });
  for (const row of [{ ...entry(), verified_source: null }, { ...entry(), verified_source: 'https://example.com/private' }, { ...entry(), status: 'invented' }, { ...entry(), status: ['verified'] }]) {
    await registry([row]);
    expect(await cmdModels(['verify'], opts())).toBe(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])).toMatchObject({ ok: false, error: 'Cannot read or validate model registry.' });
  }
  expect(await cmdModels(['verify', '--text', '--json'], opts())).toBe(2);
  expect(await cmdModels(['list', '--text'], opts())).toBe(2);
});
