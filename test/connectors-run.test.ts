import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConnector } from '../src/core/connectors/run.js';
import { updateProfile, validateProfile } from '../src/core/connectors/profile.js';
import { cmdConnectors } from '../src/cli/connectors.js';

let home: string;
const selectors = { scope: 'repo-read', tool: 'codex', lane: 'work' };
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'connectors-run-'));
  vi.stubEnv('HOME', home);
  await updateProfile(() => validateProfile({ version: 1, connectors: [{
    id: 'github', kind: 'cli', command: 'gh', scopes: ['repo-read'], tools: ['codex'], lanes: ['work'],
    credentials: [{ binding: 'GH_TOKEN', name: 'github-access' }],
  }, { id: 'mail', kind: 'mcp-http', url: 'https://example.com/mcp' }] }), home);
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });
it('denies execution even with matching selectors and binding names', async () => {
  await expect(runConnector('github', selectors, ['repo', 'list', '--json', 'name'], home)).rejects.toThrow('pending Security review');
});
it.each(['scope', 'tool', 'lane'] as const)('denies a mismatched or empty %s', async key => {
  for (const value of ['', 'other']) await expect(runConnector('github', { ...selectors, [key]: value }, [], home)).rejects.toThrow('selectors denied');
});
it('refuses MCP execution and missing connectors', async () => {
  await expect(runConnector('mail', selectors, [], home)).rejects.toThrow('Only CLI');
  await expect(runConnector('missing', selectors, [], home)).rejects.toThrow('not found');
});
it('refuses credential arguments without echoing them', async () => {
  await expect(runConnector('github', selectors, ['--token', 'not-a-value'], home)).rejects.toThrow('Credential arguments refused');
});
it('returns JSON denial and preserves child --json after the separator', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdConnectors(['run', 'github', '--scope', 'repo-read', '--tool', 'codex', '--lane', 'work', '--json', '--', 'repo', 'list', '--json', 'name'])).toBe(2);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({ ok: false, error: expect.stringContaining('pending Security review') });
});
it('requires a separator and rejects repeated selectors', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdConnectors(['run', 'github', '--json'])).toBe(2);
  expect(await cmdConnectors(['run', 'github', '--scope', 'repo-read', '--scope', 'repo-read', '--json', '--'])).toBe(2);
});
