import { describe, expect, it } from 'vitest';
import { secretsSetupOffer } from '../src/cli/enroll-secrets-offer.js';
import type { PhantomStatus } from '../src/core/types.js';

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
