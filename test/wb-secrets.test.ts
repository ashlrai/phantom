import { describe, expect, it, vi } from 'vitest';
import { projectSecrets } from '../src/core/workbench/secrets-model.js';
import { readWorkbenchSecrets } from '../src/core/workbench/secrets.js';

const probe = ['sk', '-FAKE', '-custody', '0123456789abcdef0123456789'].join('');
describe('Secrets custody boundary', () => {
  it('drops all value-shaped fields including nested payloads before the read model', () => {
    const result = projectSecrets({ secrets: [{ name: 'DEPLOY_KEY', scope: 'project',
      created_at: '2026-11-01T00:00:00Z', last_rotated: '2026-11-02T00:00:00Z',
      value: probe, plaintext: probe, token: probe, nested: { value: probe }, encrypted_value: probe }], value: probe }, Date.parse('2026-11-03T00:00:00Z'));
    expect(result).toEqual({ v: 1, state: 'ok', secrets: [{ name: 'DEPLOY_KEY', scope: 'project', ageMs: 172800000, lastRotated: '2026-11-02T00:00:00.000Z' }] });
    expect(JSON.stringify(result)).not.toContain(probe);
  });
  it('redacts secret-shaped labels and suppresses raw errors and subprocess logs', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(process.stderr, 'write')];
    try {
      const result = await readWorkbenchSecrets(async () => JSON.stringify([{ name: probe, scope: probe, value: probe }]));
      expect(JSON.stringify(result)).not.toContain(probe);
      expect(result.secrets[0]?.name).toContain('[REDACTED]');
      expect(await readWorkbenchSecrets(async () => { throw new Error(probe); })).toEqual({ v: 1, state: 'unknown', secrets: [] });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally { spies.forEach(spy => spy.mockRestore()); }
  });
  it('keeps unknown metadata honest and rejects malformed output', async () => {
    expect(projectSecrets([{ name: 'KEY', scope: { value: probe }, createdAt: 'bad', ageMs: Infinity }]).secrets[0]).toEqual({ name: 'KEY', scope: null, ageMs: null, lastRotated: null });
    for (const raw of ['bad json', '{}']) expect((await readWorkbenchSecrets(async () => raw)).state).toBe('unknown');
    expect(projectSecrets([])).toEqual({ v: 1, state: 'ok', secrets: [] });
  });
});
