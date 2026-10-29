import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { secretsSetupOffer } from '../src/cli/enroll-secrets-offer.js';
import { cmdEnroll } from '../src/cli/sandbox.js';
import type { PhantomStatus } from '../src/core/types.js';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  enroll: vi.fn(),
}));
vi.mock('../src/core/phantom.js', () => ({ getPhantomStatus: mocks.status }));
vi.mock('../src/core/sandbox/policy.js', () => ({
  readEnrollmentRegistry: () => ({ state: 'ready', repos: ['existing'], reason: 'ok' }),
  enroll: mocks.enroll,
  unenroll: vi.fn(),
  killSwitchOn: vi.fn(),
  setKill: vi.fn(),
}));

const base = { version: '0.7.9', secretNames: [], capability: {} } as unknown as PhantomStatus;
const dir = () => true;

describe('enroll Secrets setup offer', () => {
  it('stays silent for non-directory repo identifiers', () => {
    expect(secretsSetupOffer('ashlrai/phantom', { isDirectory: () => false, status: () => { throw new Error('no'); } })).toEqual([]);
  });

  it('offers install then a dry-run preview when Secrets is missing', () => {
    const lines = secretsSetupOffer('/tmp/repo', { isDirectory: dir, status: () => ({ ...base, installed: false, initialized: false }) });
    expect(lines.join('\n')).toContain('brew install ashlrai/phantom/phantom');
    expect(lines.join('\n')).toContain('phantom init --all /tmp/repo --dry-run');
  });

  it('shows preview before the mutating init for an unprotected repo', () => {
    const lines = secretsSetupOffer('/tmp/my repo', { isDirectory: dir, status: () => ({ ...base, installed: true, initialized: false }) });
    const text = lines.join('\n');
    expect(text.indexOf('--dry-run')).toBeGreaterThan(-1);
    expect(text.indexOf('--dry-run')).toBeLessThan(text.indexOf('&& phantom init'));
    expect(text).toContain("'/tmp/my repo'");
  });

  it('quotes apostrophes in the suggested shell commands', () => {
    const lines = secretsSetupOffer("/tmp/repo's name", { isDirectory: dir, status: () => ({ ...base, installed: true, initialized: false }) });
    expect(lines.join('\n')).toContain("'/tmp/repo'\\''s name'");
  });

  it('reports configured projects by name count only', () => {
    const lines = secretsSetupOffer('/tmp/repo', {
      isDirectory: dir,
      status: () => ({ ...base, installed: true, initialized: true, secretNames: ['OPENAI_API_KEY', 'STRIPE_KEY'] }),
    });
    expect(lines).toEqual(['Phantom Secrets: configured (2 secret names; values never read).']);
    expect(lines.join('')).not.toContain('OPENAI_API_KEY');
  });

  it('degrades to a doctor hint on status errors', () => {
    const lines = secretsSetupOffer('/tmp/repo', { isDirectory: dir, status: () => ({ ...base, installed: true, initialized: false, error: 'status-unavailable' } as PhantomStatus) });
    expect(lines[0]).toContain('phm doctor');
  });
});

describe('enroll add Secrets offer integration', () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.status.mockReset();
    mocks.enroll.mockReset();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('offers a preview only after successful human enrollment', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'enroll-offer-'));
    directories.push(repo);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.enroll.mockReturnValue({ ok: true, quiesced: true, reason: 'ok' });
    mocks.status.mockReturnValue({ ...base, installed: true, initialized: false });

    expect(await cmdEnroll(['add', repo, '--yes'])).toBe(0);
    expect(mocks.status).toHaveBeenCalledOnce();
    expect(log.mock.calls.flat().join('\n')).toContain('phantom init --all');

    mocks.status.mockClear();
    expect(await cmdEnroll(['add', repo, '--json'])).toBe(0);
    expect(await cmdEnroll(['add', repo, '--no-secrets-offer'])).toBe(0);
    expect(mocks.status).not.toHaveBeenCalled();

    mocks.enroll.mockReturnValue({ ok: false, quiesced: false, reason: 'degraded' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdEnroll(['add', repo])).toBe(1);
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it('keeps successful enrollment when the advisory probe throws', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'enroll-offer-'));
    directories.push(repo);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.enroll.mockReturnValue({ ok: true, quiesced: true, reason: 'ok' });
    mocks.status.mockImplementation(() => { throw new Error('probe failed'); });
    expect(await cmdEnroll(['add', repo, '--yes'])).toBe(0);
  });
});
