import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'smol-toml';
import { assertMetadata, encodeProfile, importClients, profilePath, readProfile, updateProfile, validateProfile } from '../src/core/connectors/profile.js';
import { cmdConnectors } from '../src/cli/connectors.js';

let home: string;
const base = () => ({ id: 'context7', kind: 'mcp-http', url: 'https://mcp.context7.com/mcp', scopes: ['docs'], tools: ['claude'], lanes: ['work'], credentials: [{ binding: 'ACCESS', name: 'context7-access' }] });
const profile = () => validateProfile({ version: 1, connectors: [base()] });
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'connector-profile-')); });
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });
async function client(data: unknown) { await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: data })); }

describe('connector metadata boundary', () => {
  it('round-trips every connector kind through TOML and disk', async () => {
    const p = profile();
    for (const kind of ['mcp-stdio', 'cli', 'plugin']) p.connectors.push(validateProfile({ version: 1, connectors: [{ id: kind, kind, command: 'example', args: ['--read-only'] }] }).connectors[0]!);
    await updateProfile(() => p, home);
    expect(await readProfile(home)).toEqual(p);
    expect(parse(encodeProfile(p))).toEqual(p);
    const gate = spawnSync('perl', ['.github/tests/secret-shape/scrub.pl', '--check'], { input: await readFile(profilePath(home), 'utf8'), encoding: 'utf8' });
    expect(gate.status).toBe(0);
  });
  it('treats an absent profile as empty', async () => { expect(await readProfile(home)).toEqual({ version: 1, connectors: [] }); });
  it('refuses unknown fields and duplicate ids', () => {
    expect(() => validateProfile({ version: 1, connectors: [{ ...base(), env: {} }] })).toThrow('Invalid connector profile');
    expect(() => validateProfile({ version: 1, connectors: [base(), base()] })).toThrow('Duplicate');
  });
  it.each(['https://' + 'user:' + 'pass@example.com/mcp', 'https://example.com/mcp?access=opaque', 'https://example.com/#opaque', 'http://0.0.0.0/mcp', 'file:///tmp/mcp'])('refuses unsafe endpoint %s', url => {
    expect(() => validateProfile({ version: 1, connectors: [{ ...base(), url }] })).toThrow();
  });
  it.each(['http://127.0.0.1:8080/mcp', 'http://[::1]:8080/mcp', 'http://localhost:8080/mcp'])('accepts loopback endpoint %s', url => {
    expect(validateProfile({ version: 1, connectors: [{ ...base(), url }] }).connectors[0]!.url).toBe(url);
  });
  it('refuses secret-shaped values in every metadata field before disk persistence', async () => {
    const planted = ['gh' + 'p_' + 'A1'.repeat(20), 'wh' + 'sec_' + 'A1'.repeat(12), 'sk' + '_live_' + 'A1'.repeat(12), 'shp' + 'at_' + 'ab'.repeat(16), 'AS' + 'IA' + 'A'.repeat(16),
      'xapp' + '-1-' + 'A1'.repeat(12), 'xox' + 'a-' + 'A1'.repeat(12),
      'github' + '_pat_' + 'A1'.repeat(20), 'glpat' + '-' + 'A1'.repeat(12),
      'sk' + '-ant-' + 'A1'.repeat(12), 'sk' + '-proj-' + 'A1'.repeat(12),
      'AI' + 'za' + 'A'.repeat(35), 'np' + 'm_' + 'A1'.repeat(20),
      'ey' + 'J' + 'a'.repeat(12) + '.ey' + 'J' + 'b'.repeat(12) + '.' + 'c'.repeat(12)];
    await updateProfile(() => profile(), home);
    const original = await readFile(profilePath(home), 'utf8');
    for (const value of planted) {
      expect(() => assertMetadata(value)).toThrow('Secret-shaped');
      for (const field of ['id', 'url', 'command', 'args', 'scopes', 'tools', 'lanes', 'credentials']) {
        const bad = { ...base(), [field]: ['args', 'scopes', 'tools', 'lanes'].includes(field) ? [value] : field === 'credentials' ? [{ binding: 'ACCESS', name: value }] : value };
        await expect(updateProfile(() => ({ version: 1, connectors: [bad] }) as never, home)).rejects.toThrow();
      }
    }
    expect(await readFile(profilePath(home), 'utf8')).toBe(original);
  });
  it('refuses a contaminated manually edited profile without echoing content', async () => {
    await mkdir(join(home, '.phantom', 'connectors'), { recursive: true });
    const value = 'gh' + 'p_' + 'Z2'.repeat(20);
    await writeFile(profilePath(home), `version = 1\n# ${value}`);
    await expect(readProfile(home)).rejects.toThrow('Secret-shaped');
  });
  it('does not overwrite a locked profile', async () => {
    await updateProfile(() => profile(), home);
    await mkdir(join(home, '.phantom', 'connectors', '.profile-lock'));
    await expect(updateProfile(() => ({ version: 1, connectors: [] }), home)).rejects.toThrow('locked');
    expect((await readProfile(home)).connectors).toHaveLength(1);
  });
  it('refuses profile symlinks and credential flags with separated values', async () => {
    await mkdir(join(home, '.phantom', 'connectors'), { recursive: true });
    const target = join(home, 'metadata.toml');
    await writeFile(target, encodeProfile(profile()));
    await symlink(target, profilePath(home));
    await expect(readProfile(home)).rejects.toThrow('Symlinked');
    await expect(updateProfile(() => profile(), home)).rejects.toThrow('Symlinked');
    expect(() => validateProfile({ version: 1, connectors: [{ id: 'example', kind: 'cli', command: 'example', args: ['--token', 'opaque'] }] })).toThrow('Credential arguments');
  });
  it('does not relay malformed TOML values', async () => {
    await updateProfile(() => profile(), home);
    await writeFile(profilePath(home), 'invalid = [');
    await expect(readProfile(home)).rejects.toThrow('Invalid profile TOML');
  });
});

describe('client metadata import', () => {
  it('imports all requested provider names and safe URLs without inventing endpoints', async () => {
    const ids = ['context7', 'github', 'sentry', 'posthog', 'supabase', 'vercel', 'gmail', 'drive'];
    await client(Object.fromEntries(ids.map(id => [id, { url: `https://${id}.example.com/mcp`, type: 'http' }])));
    const result = await importClients(home, '');
    expect(result.imported).toEqual(ids);
    expect((await readProfile(home)).connectors.map(c => c.url)).toEqual(ids.map(id => `https://${id}.example.com/mcp`));
    expect(result.skipped.some(s => s.source === 'codex-lane')).toBe(true);
  });
  it('withholds credential-bearing configs and never includes their payload in reports or profile', async () => {
    const value = 'runtime-' + 'sensitive-' + 'value';
    await client({ github: { command: 'gh', env: { ACCESS: value } }, sentry: { url: 'https://sentry.example.com', headers: { Authorization: value } }, context7: { command: 'npx', args: [value] } });
    const report = await importClients(home, '');
    expect(report.imported).toEqual([]);
    expect(report.skipped.filter(s => s.source === 'claude')).toHaveLength(3);
    expect(report.skipped.some(s => s.source === 'cursor')).toBe(true);
    expect(JSON.stringify(report)).not.toContain(value);
    expect(await readProfile(home)).toEqual({ version: 1, connectors: [] });
  });
  it('preserves existing connector ids on repeated import', async () => {
    await client({ context7: { url: base().url } });
    await importClients(home, '');
    expect((await importClients(home, '')).imported).toEqual([]);
    expect((await readProfile(home)).connectors).toHaveLength(1);
  });
  it('imports only an explicit lane Codex home and rejects the default home and symlinks', async () => {
    const lane = join(home, '.ashlr-runs', 'lane', 'codex-home');
    await mkdir(lane, { recursive: true });
    await writeFile(join(lane, 'config.toml'), '[mcp_servers.github]\nurl = "https://github.example.com/mcp"');
    expect((await importClients(home, lane)).imported).toEqual(['github']);
    const forbidden = join(home, '.codex');
    await mkdir(forbidden);
    // A directory sentinel fails if read as config; it must never be opened.
    await mkdir(join(forbidden, 'config.toml'));
    expect((await importClients(home, forbidden)).skipped.some(s => s.source === 'codex-lane')).toBe(true);
    await symlink(forbidden, join(home, '.ashlr-runs', 'alias'));
    expect((await importClients(home, join(home, '.ashlr-runs', 'alias'))).skipped.some(s => s.source === 'codex-lane')).toBe(true);
  });
});

describe('connector CLI JSON contract', () => {
  it('adds, shows, lists and removes with credential references', async () => {
    vi.stubEnv('HOME', home);
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdConnectors(['add', 'github', '--kind', 'cli', '--command', 'gh', '--credential', 'ACCESS=github-access', '--json'])).toBe(0);
    expect(await cmdConnectors(['show', 'github', '--json'])).toBe(0);
    expect(JSON.parse(String(out.mock.calls.at(-1)![0])).connector.credentials[0].name).toBe('github-access');
    expect(await cmdConnectors(['list', '--json'])).toBe(0);
    expect(await cmdConnectors(['remove', 'github', '--json'])).toBe(0);
    expect((await readProfile(home)).connectors).toEqual([]);
  });
  it('returns actionable JSON errors without echoing invalid input', async () => {
    vi.stubEnv('HOME', home);
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const args of [['show', 'missing'], ['add', 'example', '--kind'], ['remove', 'missing'], ['unknown'], ['list', '--unknown'], ['add', 'example', '--kind', 'cli', '--command', 'gh', '--command', 'other']]) {
      expect(await cmdConnectors([...args, '--json'])).toBe(2);
      expect(JSON.parse(String(out.mock.calls.at(-1)![0]))).toMatchObject({ ok: false, error: expect.any(String) });
    }
  });
});
