import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawnSync,
}));
import { getPhantomStatus } from '../../src/core/phantom.js';
// @ts-expect-error Plain ESM contract tooling shared with the standalone checker.
import { assertSupportedSchema, checkContract, loadSchema, products, readJson, validateJson } from './cli-json-contract.mjs';

type JsonObject = Record<string, any>;
const fixture = (name: string): JsonObject => readJson(new URL(`./fixtures/${name}.json`, import.meta.url));
const cases = [
  ['locus', 'locus-ready', 0], ['locus', 'locus-protected', 1], ['locus', 'locus-unsafe', 2],
  ['lexicon', 'lexicon-handshake', 0],
  ...['configured', 'missing', 'invalid', 'unreadable', 'lock-unavailable'].map(state => ['phantom-secrets', `phantom-secrets-${state}`, 0]),
] as const;

afterEach(() => spawnSync.mockReset());

describe('pinned cross-repository CLI JSON contracts', () => {
  it('records all producer revisions and preserves the upstream Locus schema bytes', () => {
    const pins = readJson(new URL('./producer-pins.json', import.meta.url));
    expect(pins.producers.map((producer: JsonObject) => producer.repo).sort()).toEqual([
      'ashlrai/lexicon', 'ashlrai/locus', 'ashlrai/phantom-secrets',
    ]);
    for (const producer of pins.producers) {
      expect(producer.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(producer.sources.length).toBeGreaterThan(0);
      for (const source of producer.sources) expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    const locus = pins.producers.find((producer: JsonObject) => producer.repo === 'ashlrai/locus');
    const source = locus.sources.find((entry: JsonObject) => entry.path === 'schema/agent-report.schema.json');
    const bytes = readFileSync(new URL('./schemas/locus-agent-report.schema.json', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256);
  });

  it.each(cases)('%s accepts the source-derived %s fixture (exit %s)', (product, name, exit) => {
    expect(checkContract(product, fixture(name as string), exit)).toEqual([]);
  });

  it.each(products)('%s detects deleted required fields and type drift at every described depth', product => {
    const name = product === 'locus' ? 'locus-ready' : product === 'lexicon' ? 'lexicon-handshake' : 'phantom-secrets-configured';
    const schema = loadSchema(product);
    let mutations = 0;
    function walk(rule: JsonObject, value: JsonObject, path: string[]) {
      if (rule.$ref) rule = schema.$defs[rule.$ref.split('/').at(-1)];
      for (const key of rule.required ?? []) {
        const changed = fixture(name);
        const parent = path.reduce((node, part) => node[part], changed);
        delete parent[key];
        expect(validateJson(schema, changed).length, `missing ${[...path, key].join('.')}`).toBeGreaterThan(0);
        mutations++;
      }
      for (const [key, child] of Object.entries(rule.properties ?? {}) as [string, JsonObject][]) {
        if (!Object.hasOwn(value, key)) continue;
        const changed = fixture(name);
        const parent = path.reduce((node, part) => node[part], changed);
        parent[key] = typeof value[key] === 'string' ? 42 : 'wrong-type';
        expect(validateJson(schema, changed).length, `type of ${[...path, key].join('.')}`).toBeGreaterThan(0);
        mutations++;
        if (value[key] !== null && typeof value[key] === 'object' && !Array.isArray(value[key])) walk(child, value[key], [...path, key]);
      }
    }
    walk(schema, fixture(name), []);
    expect(mutations).toBeGreaterThan(20);
  });

  it.each(['locus', 'lexicon'])('%s preserves the upstream additive-field policy', product => {
    const value = fixture(product === 'locus' ? 'locus-ready' : 'lexicon-handshake');
    value.future_optional_field = true;
    expect(checkContract(product, value, 0)).toEqual([]);
  });

  it('checks optional Locus pins through local schema references', () => {
    const value = fixture('locus-ready');
    value.pin = { alias: 'contract', tenant: 'synthetic', binding_id: 'fixture', expires_at: '2099-01-01T00:00:00Z', seal_ok: true, expired: false };
    expect(checkContract('locus', value, 0)).toEqual([]);
    value.pin.seal_ok = 'true';
    expect(checkContract('locus', value, 0)).toContain('$.pin.seal_ok: type changed');
  });

  it.each([['locus', 'locus-ready'], ['lexicon', 'lexicon-handshake'], ['phantom-secrets', 'phantom-secrets-configured']])('%s rejects a CLI failure even with valid JSON', (product, name) => {
    expect(checkContract(product, fixture(name), 2).length).toBeGreaterThan(0);
  });

  it('requires Locus readiness, status and process/document exit codes to agree', () => {
    const value = fixture('locus-ready');
    for (const mutation of [{ ready: false }, { exit_code: 1 }, { status: 'future-state' }, { required_servers: ['unrelated', 'other'] }]) {
      expect(checkContract('locus', { ...value, ...mutation }, 0).length).toBeGreaterThan(0);
    }
  });

  it('checks Lexicon protocol versions, vocabulary, uniqueness and array members', () => {
    const value = fixture('lexicon-handshake');
    for (const mutation of [
      { schema_version: 2 }, { version: 'latest' }, { name: 'another-product' },
      { protocols: { 'ashlr.handshake': '1' } }, { protocols: { 'ashlr.handshake': 1, mcp: '1' } },
      { capabilities: ['mcp-server', 'mcp-server'] }, { capabilities: ['UPPER_CASE'] },
      { health: { status: 'ready', checks: [] } },
      { health: { status: 'ok', checks: [{ id: 'global-lexicon', status: 'ready' }] } },
      { health: { status: 'ok', checks: [{ id: 'global-lexicon', status: 'missing' }] } },
      { edits: ['/absolute/path'] },
      { edits: [42] }, { receipts: [false] },
    ]) expect(checkContract('lexicon', { ...value, ...mutation }, 0).length).toBeGreaterThan(0);
  });

  it('refuses unknown schema constraints and external or unresolved references', () => {
    expect(() => assertSupportedSchema({ type: 'object', properties: { item: { minimum: 1 } } })).toThrow('Unsupported schema keyword');
    expect(() => assertSupportedSchema({ type: 'number' })).toThrow('Unsupported schema type');
    expect(() => assertSupportedSchema({ type: 'array', items: false })).toThrow('Expected an object schema');
    expect(() => assertSupportedSchema({ $ref: 'https://example.invalid/schema' })).toThrow('Only local');
    expect(() => validateJson({ $ref: '#/$defs/missing' }, {})).toThrow('Unresolved');
  });

  it.each(products)('%s rejects null, arrays and primitives as the report root', product => {
    for (const value of [null, [], true, 'ready', 1]) expect(checkContract(product, value, 0).length).toBeGreaterThan(0);
  });
});

describe('Phantom consumes the pinned Secrets status documents', () => {
  function install(value: unknown) {
    spawnSync.mockImplementation((_binary: string, args: string[]) => {
      let stdout: string;
      if (args[0] === '--version') stdout = 'phantom 0.7.9';
      else if (args[0] === 'status') stdout = JSON.stringify(value);
      else if (args[0] === 'list') stdout = '[]';
      else if (args[0] === '--help') stdout = 'Commands:\n  status\n  list\n  exec\n  mcp\n\nOptions:\n';
      else throw new Error('Unexpected companion invocation');
      return { stdout, stderr: '', status: 0, signal: null };
    });
  }

  it.each(['configured', 'missing', 'invalid', 'unreadable', 'lock-unavailable'])('consumes %s without granting injection capability', state => {
    const value = fixture(`phantom-secrets-${state}`);
    install(value);
    const observed = getPhantomStatus({ cwd: '/contract/project' });
    expect(observed.initialized).toBe(value.initialized);
    expect(observed.error).toBe(['invalid', 'unreadable'].includes(state) ? 'status-config-unavailable' : undefined);
    expect(observed.capability.modes.childEnvInjectionAvailable).toBe(false);
    expect(spawnSync.mock.calls.some(call => call[1][0] === 'list')).toBe(value.initialized);
  });

  it.each([
    { schema_version: 2 }, { initialized: 'true' }, { inspection: 'vault' },
    { vault: { inspected: true } }, { managed_dotenv: { inspected: true } },
    { proxy: { lifecycle_lock: 'held', listener_authenticated: true } },
    { proxy: { lifecycle_lock: 'running', listener_authenticated: false } },
    { issues: ['unknown-issue'] }, { issues: Array(5).fill('config-missing') },
    { unexpected: 'synthetic-private-marker' },
  ])('the schema and real consumer both reject incompatible metadata %#', mutation => {
    const value = { ...fixture('phantom-secrets-configured'), ...mutation };
    expect(checkContract('phantom-secrets', value, 0).length).toBeGreaterThan(0);
    install(value);
    const observed = getPhantomStatus();
    expect(observed).toMatchObject({ initialized: false, error: 'status-contract-unsupported', secretNames: [] });
    expect(spawnSync.mock.calls.some(call => call[1][0] === 'list')).toBe(false);
  });
});

describe('standalone producer capture check', () => {
  // Retain an unmocked process launcher for the standalone checker itself.
  const launch = vi.importActual<typeof import('node:child_process')>('node:child_process');
  const harness = fileURLToPath(new URL('./check-cli-json.mjs', import.meta.url));
  async function run(change?: (root: string) => void) {
    const root = mkdtempSync(join(tmpdir(), 'xrepo-contract-'));
    try {
      for (const [product, name] of [['locus', 'locus-protected'], ['lexicon', 'lexicon-handshake'], ['phantom-secrets', 'phantom-secrets-missing']]) {
        writeFileSync(join(root, `${product}.json`), JSON.stringify(fixture(name)));
        writeFileSync(join(root, `${product}.exit-code`), product === 'locus' ? '1\n' : '0\n');
      }
      change?.(root);
      return (await launch).spawnSync(process.execPath, [harness, root], {
        env: { HOME: root, USERPROFILE: root, TMPDIR: root, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) },
        encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('checks all three products, including nonzero healthy-contract Locus observations', async () => {
    const result = await run();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['locus: PASS', 'lexicon: PASS', 'phantom-secrets: PASS']);
  });

  it('accepts CRLF exit-code files from Windows capture jobs', async () => {
    const result = await run(root => writeFileSync(join(root, 'lexicon.exit-code'), '0\r\n'));
    expect(result.status).toBe(0);
  });

  it.each(products)('%s drift fails the actual capture checker', async product => {
    const result = await run(root => writeFileSync(join(root, `${product}.json`), '{"schema_version":999}'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${product}: FAIL`);
  });

  it.each(['missing-json', 'missing-exit', 'wrong-exit', 'malformed', 'multiple-documents', 'oversized'])('fails closed on %s without echoing producer data', async fault => {
    const marker = 'synthetic-private-marker';
    const result = await run(root => {
      const json = join(root, 'lexicon.json');
      const exit = join(root, 'lexicon.exit-code');
      if (fault === 'missing-json') rmSync(json);
      else if (fault === 'missing-exit') rmSync(exit);
      else if (fault === 'wrong-exit') writeFileSync(exit, '2\n');
      else if (fault === 'malformed') writeFileSync(json, marker);
      else if (fault === 'multiple-documents') writeFileSync(json, readFileSync(json, 'utf8') + '\n{}');
      else writeFileSync(json, marker.repeat(100_000));
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lexicon: FAIL');
    expect(result.stdout + result.stderr).not.toContain(marker);
  });

  it('does not silently skip when no capture directory is supplied', async () => {
    const result = (await launch).spawnSync(process.execPath, [harness], { encoding: 'utf8', timeout: 5_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage:');
  });
});
