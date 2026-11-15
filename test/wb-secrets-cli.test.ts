import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/core/workbench/secrets.js', () => ({ readWorkbenchSecrets: vi.fn() }));
import { readWorkbenchSecrets } from '../src/core/workbench/secrets.js';
import { cmdWb } from '../src/cli/wb.js';
afterEach(() => vi.restoreAllMocks());
it('prints the shared metadata reading in JSON and human output', async () => {
  vi.mocked(readWorkbenchSecrets).mockResolvedValue({ v: 1, state: 'ok', secrets: [{ name: 'KEY', scope: 'repo', ageMs: 86400000, lastRotated: null }] });
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdWb(['secrets', '--json'])).toBe(0);
  expect(JSON.parse(String(output.mock.calls[0]?.[0])).secrets[0].name).toBe('KEY');
  expect(await cmdWb(['secrets'])).toBe(0);
  expect(output.mock.calls.flat().join('\n')).toContain('1 days');
});
it('returns unknown and usage failures honestly', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(readWorkbenchSecrets).mockResolvedValue({ v: 1, state: 'unknown', secrets: [] });
  expect(await cmdWb(['secrets', '--json'])).toBe(1);
  expect(await cmdWb(['secrets', '--reveal'])).toBe(2);
});
