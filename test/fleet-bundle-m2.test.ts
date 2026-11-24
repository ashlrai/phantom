import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { exportBundle, importBundle, readExportPart, writeBundleFile, readBundleFile } from '../src/core/bundles/index.js';
import { bundlePart, canonicalBundleJson, encodeBundle, parseBundle, type Bundle } from '../src/core/bundles/schema.js';
import { readAgentProfile, listAgentProfiles, writeAgentProfile, agentProfileVersions, pinAgentProfile } from '../src/core/agents/agent-profile.js';
import { updateProfile } from '../src/core/connectors/profile.js';
import * as scrub from '../src/core/util/scrub.js';

let home: string;
const principal = 'own_' + 'a'.repeat(32);
const connector = (url = 'https://tools.example.test/mcp') => ({ id: 'helper', kind: 'mcp-http', url, credentials: [{ binding: 'GH_TOKEN', name: 'github-access' }] });
function tool(value: unknown = connector()): Bundle {
  return { schema: 'phantom.bundle.v1', version: 1, kind: 'tool', principal, parts: [bundlePart('connector', 'connectors/helper.json', canonicalBundleJson(value))] };
}
async function fixture() {
  const dir = join(home, '.phantom', 'bots', 'reviewer');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'doctrine.md'), '# Review\nDraft useful review notes.\n');
  await writeFile(join(dir, 'memory-seed.md'), '# Selected memory\nPrefer reproducible evidence.\n');
  await mkdir(join(dir, 'prompts'));
  await writeFile(join(dir, 'prompts', 'review.md'), 'Check the changed behavior.');
  await updateProfile(p => ({ ...p, connectors: [{ ...connector(), args: [], scopes: [], tools: [], lanes: [] }] }), home);
  await writeAgentProfile({ id: 'reviewer', displayName: 'Reviewer', doctrine: 'bots/reviewer/doctrine.md', mcpServers: ['helper'] }, home);
  return dir;
}
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'fleet-bundle-m2-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

describe('phantom.bundle.v1 canonical metadata', () => {
  it('uses RFC 8785 UTF-16 sorting and ECMAScript primitive rendering', () => {
    expect(canonicalBundleJson({ '\ufffd': 1, '\ud83d\ude00': 2, '\u20ac': 3, '\r': 4 })).toBe('{"\\r":4,"€":3,"😀":2,"�":1}');
    expect(canonicalBundleJson(JSON.parse('[333333333.33333329,1e30,4.50,2e-3,1e-27,-0]'))).toBe('[333333333.3333333,1e+30,4.5,0.002,1e-27,0]');
    const getter = vi.fn(() => 'unsafe');
    for (const value of ['\ud800', '\udc00', NaN, undefined, new Date(), Array(1), Object.defineProperty({}, 'x', { get: getter, enumerable: true })]) expect(() => canonicalBundleJson(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects unknown fields, duplicate keys, malformed parts and digest changes', () => {
    const bundle = tool(), raw = canonicalBundleJson(bundle);
    expect(parseBundle(raw)).toEqual(bundle);
    expect(() => parseBundle(raw.replace('"version":1', '"version":1,"version":1'))).toThrow(/canonical/);
    expect(() => parseBundle(canonicalBundleJson({ ...bundle, authority: true }))).toThrow();
    expect(() => parseBundle(canonicalBundleJson({ ...bundle, principal: principal + '\n' }))).toThrow();
    expect(() => parseBundle(canonicalBundleJson({ ...bundle, parts: [{ ...bundle.parts[0], content: '{}' }] }))).toThrow(/digest/);
    expect(() => parseBundle(canonicalBundleJson({ ...bundle, parts: [...bundle.parts, bundle.parts[0]] }))).toThrow(/duplicate/);
  });
  it('round-trips export, inspect and the existing agent profile reader and history', async () => {
    await fixture();
    const bundle = await exportBundle('agent', 'reviewer', { home, principal });
    const file = join(home, 'reviewer.bundle.json');
    await writeBundleFile(file, bundle);
    await importBundle(await readBundleFile(file), { home, as: 'copy', apply: true });
    const profile = await readAgentProfile('copy', home);
    expect(profile.policy.send).toBe('drafts-only');
    expect(profile.mcpServers).toEqual([]);
    expect((await listAgentProfiles(home)).map(p => p.id)).toEqual(['copy', 'reviewer']);
    await writeAgentProfile({ ...profile, displayName: 'Updated' }, home);
    expect(await agentProfileVersions('copy', home)).toEqual([1, 2]);
    expect((await pinAgentProfile('copy', 1, home)).displayName).toBe('Reviewer');
    const again = await exportBundle('agent', 'copy', { home });
    expect(again.parts.filter(p => p.kind === 'connector')).toHaveLength(1);
    expect(again.parts.filter(p => p.kind === 'prompt')).toHaveLength(1);
  });
});

describe('M2-3 confined inert import', () => {
  it('is a dry run by default and writes only inside the new profile directory on apply', async () => {
    const raw = encodeBundle(tool());
    const before = await readdir(home);
    expect((await importBundle(raw, { home, as: 'copy' })).dryRun).toBe(true);
    expect(await readdir(home)).toEqual(before);
    expect((await importBundle(raw, { home, as: 'copy', apply: true })).dryRun).toBe(false);
    expect(await readdir(join(home, '.phantom', 'agents'))).toEqual(['copy']);
    const dir = join(home, '.phantom', 'agents', 'copy');
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(dir, 'connectors', 'helper.json'))).mode & 0o777).toBe(0o600);
  });
  it.each(['../escape', '/absolute', 'C:\\escape', 'nested/../../escape', 'copy\n'])('refuses traversal or absolute destination %s', async id => {
    await expect(importBundle(encodeBundle(tool()), { home, as: id, apply: true })).rejects.toThrow();
    expect(await readdir(home)).toEqual([]);
  });
  it.each(['../escape.md', '/escape.md', 'doctrine.md\n', 'prompts/../../escape.md', 'prompts/leader.md', 'prompts/wrapper.md', 'wrappers/run.sh', 'dispatchd.py', 'publish.sh', 'scrub.pl', 'pinned/run.sh'])('refuses escaping or pinned part target %s', async path => {
    const bundle = tool(); bundle.parts[0]!.path = path;
    await expect(importBundle(canonicalBundleJson(bundle), { home, as: 'copy', apply: true })).rejects.toThrow();
    expect(await readdir(home)).toEqual([]);
  });
  it('refuses symlink escapes at the profile root and destination', async () => {
    const outside = join(home, 'outside'); await mkdir(outside);
    await symlink(outside, join(home, '.phantom'));
    await expect(importBundle(encodeBundle(tool()), { home, as: 'copy', apply: true })).rejects.toThrow(/Symlink/);
    expect(await readdir(outside)).toEqual([]);
    await rm(join(home, '.phantom'));
    await mkdir(join(home, '.phantom', 'agents'), { recursive: true });
    await symlink(outside, join(home, '.phantom', 'agents', 'copy'));
    await expect(importBundle(encodeBundle(tool()), { home, as: 'copy', apply: true })).rejects.toThrow(/Symlink/);
  });
  it('refuses every existing destination without replacement, including macOS immutable-flagged targets', async () => {
    const dir = join(home, '.phantom', 'agents', 'copy'); await mkdir(dir, { recursive: true });
    const path = join(dir, 'profile.toml'); await writeFile(path, 'immutable fixture', { mode: 0o400 });
    // The production invariant rejects all existing targets, independently of platform flags.
    // On macOS this exercises a real fixture flag, removed even if the assertion fails.
    if (process.platform === 'darwin') execFileSync('/usr/bin/chflags', ['uchg', path]);
    try {
      await expect(importBundle(encodeBundle(tool()), { home, as: 'copy', apply: true })).rejects.toThrow(/already exists/);
      expect(await readFile(path, 'utf8')).toBe('immutable fixture');
    } finally { if (process.platform === 'darwin') execFileSync('/usr/bin/chflags', ['nouchg', path]); }
  });
  it.each(['https://127.0.0.1', 'https://127.1', 'https://0.0.0.0', 'https://10.2.3.4', 'https://172.16.0.1', 'https://172.31.255.254', 'https://192.168.1.1', 'https://169.254.1.1', 'https://[::1]', 'https://[::]', 'https://[fc00::1]', 'https://[fdff::1]', 'https://[fe80::1]', 'https://[febf::1]', 'https://[::ffff:127.0.0.1]', 'https://localhost', 'https://LOCALHOST.', 'https://tools.localhost', 'https://localhost.localdomain', 'https://ip6-localhost'])('refuses private, link-local or loopback URL %s', async url => {
    await expect(importBundle(canonicalBundleJson(tool(connector(url))), { home, as: 'copy' })).rejects.toThrow();
  });
  it('keeps public literal and unresolved hostname URLs disabled data without binding a same-named secret', async () => {
    await mkdir(join(home, '.phantom', 'secrets'), { recursive: true });
    const secret = join(home, '.phantom', 'secrets', 'github-access');
    await writeFile(secret, 'fixture value never resolved');
    for (const [id, url] of [['literal', 'https://8.8.8.8/mcp'], ['hostname', 'https://tools.example.test/mcp']]) {
      await importBundle(encodeBundle(tool(connector(url))), { home, as: id!, apply: true });
      const saved = JSON.parse(await readFile(join(home, '.phantom', 'agents', id!, 'connectors', 'helper.json'), 'utf8'));
      expect(saved).toMatchObject({ enabled: false, bound: false, ownerEnableRequired: true, entry: { credentials: [] }, credentialReferences: [{ binding: 'GH_TOKEN', name: 'github-access' }] });
      expect(JSON.stringify(saved)).not.toContain('fixture value');
    }
    expect(await readFile(secret, 'utf8')).toBe('fixture value never resolved');
  });
  it('requires owner enable for command-name connectors and rejects executable paths', async () => {
    const value = { id: 'helper', kind: 'cli', command: 'safe-helper' };
    await importBundle(encodeBundle(tool(value)), { home, as: 'copy', apply: true });
    expect(JSON.parse(await readFile(join(home, '.phantom', 'agents', 'copy', 'connectors', 'helper.json'), 'utf8'))).toMatchObject({ enabled: false, ownerEnableRequired: true });
    await expect(importBundle(canonicalBundleJson(tool({ ...value, command: '/usr/bin/helper' })), { home, as: 'other' })).rejects.toThrow();
  });
  it.each(['/tmp/private-file', '/etc/private-file', 'C:\\Users\\private\\data', 'eid_' + 'd'.repeat(32)])('refuses local paths and account references in portable connector fields: %s', async value => {
    await expect(importBundle(canonicalBundleJson(tool({ ...connector(), description: value })), { home, as: 'copy' })).rejects.toThrow(/Private/);
  });
  it('exports existing connector identifiers containing dots without changing their identity', async () => {
    await updateProfile(p => ({ ...p, connectors: [{ ...connector(), id: 'review.helper', args: [], scopes: [], tools: [], lanes: [] }] }), home);
    expect((await exportBundle('tool', 'review.helper', { home })).parts[0]!.path).toBe('connectors/review.helper.json');
  });
  it('imports automations disabled and zero-spend without registering them in the live automation store', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'bot.json'), JSON.stringify({ automations: ['au_review'] }));
    await mkdir(join(home, '.ashlr', 'automations'), { recursive: true });
    const definition = { v: 1, id: 'au_review', name: 'Review', enabled: true, trigger: { kind: 'schedule', rrule: 'FREQ=DAILY' }, lane: 'fleet', playbookId: null, repos: ['*'], instructions: 'Review code', maxConcurrent: 1, maxPerDay: 1, queueDepth: 1, spendCapUsd: 0, dedupeKey: null, triage: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const original = JSON.stringify({ v: 1, automations: [definition] });
    await writeFile(join(home, '.ashlr', 'automations', 'automations.json'), original);
    await importBundle(encodeBundle(await exportBundle('agent', 'reviewer', { home })), { home, as: 'copy', apply: true });
    expect(JSON.parse(await readFile(join(home, '.phantom', 'agents', 'copy', 'automations', 'au_review.json'), 'utf8'))).toMatchObject({ enabled: false, spendCapUsd: 0 });
    expect(await readFile(join(home, '.ashlr', 'automations', 'automations.json'), 'utf8')).toBe(original);
  });
});

describe('M2-6 export and import secret boundaries', () => {
  it.each(['.codex/auth.json', '.codex-personal/settings.json', '.claude/auth.json', '.cursor/sessions/data.json', 'Library/Keychains/login.keychain-db', '.env', '.env.local', 'safe/token.json', 'safe/access_token', 'safe/auth.json', 'safe/session.json', 'safe/cookies.txt', '.config/gh/hosts.yml', '.config/gcloud/config.json', '.npmrc', '.netrc', '.docker/config.json', 'Library/Application Support/Code/User/globalStorage/state.json', 'Library/Application Support/Claude/Session Storage/000001.log', 'Library/Application Support/Codex/Local Storage/leveldb/000001.log', 'Library/Application Support/ChatGPT/store/data.json', '.grok/store/data.json', '.devin/store/data.json', '.opencode/store/data.json'])('refuses fixture source %s before reading its content', async name => {
    const path = join(home, name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, 'harmless fixture');
    await expect(readExportPart(path, home)).rejects.toThrow(/Protected export/);
    await rm(path);
    // A nonexistent source still gets the path denial, proving no open/read precedes it.
    await expect(readExportPart(path, home)).rejects.toThrow(/Protected export/);
  });
  it('refuses symlinked provider stores and secret-shaped doctrine content', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'doctrine.md'), 'ghp_' + 'a'.repeat(40));
    await expect(exportBundle('agent', 'reviewer', { home })).rejects.toThrow(/Secret/);
    await rm(join(dir, 'doctrine.md'));
    await mkdir(join(home, '.codex-fixture'));
    await writeFile(join(home, '.codex-fixture', 'auth.json'), 'harmless fixture');
    await symlink(join(home, '.codex-fixture', 'auth.json'), join(dir, 'doctrine.md'));
    await expect(exportBundle('agent', 'reviewer', { home })).rejects.toThrow(/Symlink/);
  });
  it('includes memory only through explicit opt-in and uses the shared scrub unchanged on import', async () => {
    await fixture();
    expect((await exportBundle('agent', 'reviewer', { home })).parts.some(p => p.kind === 'memory')).toBe(false);
    expect((await exportBundle('agent', 'reviewer', { home, includeMemory: true })).parts.filter(p => p.kind === 'memory')).toHaveLength(1);
    const spy = vi.spyOn(scrub, 'scrubSecrets');
    const raw = encodeBundle(tool()); spy.mockClear();
    await importBundle(raw, { home, as: 'copy' });
    expect(spy).toHaveBeenCalledWith(raw);
    const bundle = tool(); bundle.parts[0] = bundlePart('connector', 'connectors/helper.json', canonicalBundleJson({ ...connector(), description: 'ghp_' + 'b'.repeat(40) }));
    await expect(importBundle(canonicalBundleJson(bundle), { home, as: 'copy' })).rejects.toThrow(/Secret/);
  });
});
