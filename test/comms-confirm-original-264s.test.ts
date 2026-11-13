import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCommsConfirmation } from '../src/core/agents/channel-policy.js';
import { confirmCommsLimits, readCommsLimits } from '../src/core/comms/comms-confirm.js';

const AT = '2026-11-09T12:00:00.000Z';
const NETWORK = '[team]\nidentities = [{ channel = "imessage", id = "imessage:0123456789abcdef" }, { channel = "slack", id = "U0FAKE0001" }]\n';
const COMMS = '# Comms limits, edited by hand\nconfirmedByMason = false  # flip me\n\n[limits]\nmaxPerDay = 3 # fake cap\nnote = "reach someone@example.invalid or +15555550100 only"\n';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'comms-confirm-'));
  writeFileSync(join(dir, 'agent-network.toml'), NETWORK, { mode: 0o600 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(text: string): void { writeFileSync(join(dir, 'comms.toml'), text, { mode: 0o600 }); }
function read(): string { return readFileSync(join(dir, 'comms.toml'), 'utf8'); }

describe('readCommsLimits', () => {
  it('reports the team allowlist, channels and other settings with a digest', () => {
    write(COMMS);
    const view = readCommsLimits(dir);
    expect(view.state).toBe('unconfirmed');
    expect(view.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(view.limits).toEqual({
      team: [{ channel: 'imessage', id: 'imessage:0123456789abcdef' }, { channel: 'slack', id: 'U0FAKE0001' }],
      channels: ['imessage', 'slack'],
      settings: [{ key: 'limits.maxPerDay', value: '3' }, { key: 'limits.note', value: '"reach someone@example.invalid or +15555550100 only"' }],
    });
  });

  it('reads a missing or malformed file as unknown', () => {
    expect(readCommsLimits(dir).state).toBe('unknown');
    write('confirmedByMason = = true');
    expect(readCommsLimits(dir)).toEqual({ state: 'unknown', limits: null, digest: null, confirmedAt: null });
    write('confirmedByMason = "yes"\n');
    expect(readCommsLimits(dir).state).toBe('unknown');
  });
});

describe('confirmCommsLimits', () => {
  it('flips only the two confirmation keys and preserves every other byte', () => {
    write(COMMS);
    const { digest } = readCommsLimits(dir);
    expect(confirmCommsLimits(dir, { limitsDigest: digest!, confirmedAt: AT })).toEqual({ ok: true, confirmedAt: AT });
    expect(read()).toBe(COMMS.replace('confirmedByMason = false  # flip me', `confirmedByMason = true  # flip me\nconfirmedAt = "${AT}"`));
    expect(parseCommsConfirmation(read())).toBe(true);
    expect(readCommsLimits(dir)).toMatchObject({ state: 'confirmed', digest, confirmedAt: AT });
  });

  it('inserts the keys when absent and replaces an existing confirmedAt', () => {
    write('[limits]\nmaxPerDay = 1\n');
    let digest = readCommsLimits(dir).digest!;
    expect(confirmCommsLimits(dir, { limitsDigest: digest, confirmedAt: AT }).ok).toBe(true);
    expect(read()).toBe(`confirmedByMason = true\nconfirmedAt = "${AT}"\n[limits]\nmaxPerDay = 1\n`);
    write('confirmedByMason = false\r\nconfirmedAt = "2026-01-01T00:00:00.000Z"\r\n');
    digest = readCommsLimits(dir).digest!;
    expect(confirmCommsLimits(dir, { limitsDigest: digest, confirmedAt: AT }).ok).toBe(true);
    expect(read()).toBe(`confirmedByMason = true\r\nconfirmedAt = "${AT}"\r\n`);
  });

  it('refuses a digest that no longer matches the limits on disk', () => {
    write(COMMS);
    const { digest } = readCommsLimits(dir);
    write(COMMS.replace('maxPerDay = 3', 'maxPerDay = 30'));
    expect(confirmCommsLimits(dir, { limitsDigest: digest!, confirmedAt: AT })).toEqual({ ok: false, reason: 'digest-mismatch' });
    expect(parseCommsConfirmation(read())).toBe(false);
    // The team allowlist is part of the limits too.
    write(COMMS);
    writeFileSync(join(dir, 'agent-network.toml'), '[team]\nidentities = []\n');
    expect(confirmCommsLimits(dir, { limitsDigest: digest!, confirmedAt: AT })).toEqual({ ok: false, reason: 'digest-mismatch' });
    expect(existsSync(join(dir, 'comms.toml.bak'))).toBe(false);
  });

  it('never creates a missing file', () => {
    expect(confirmCommsLimits(dir, { limitsDigest: `sha256:${'0'.repeat(64)}`, confirmedAt: AT })).toEqual({ ok: false, reason: 'missing' });
    expect(existsSync(join(dir, 'comms.toml'))).toBe(false);
  });

  it('refuses a malformed file without touching it', () => {
    write('confirmedByMason = = true');
    expect(confirmCommsLimits(dir, { limitsDigest: `sha256:${'0'.repeat(64)}`, confirmedAt: AT })).toEqual({ ok: false, reason: 'malformed' });
    expect(read()).toBe('confirmedByMason = = true');
  });

  it('refuses when the only confirmation line sits inside a multi-line string', () => {
    write('note = """\nconfirmedByMason = false\n"""\n');
    const { digest } = readCommsLimits(dir);
    // Inserting at the top is fine, but the string's content must not change.
    expect(confirmCommsLimits(dir, { limitsDigest: digest!, confirmedAt: AT })).toEqual({ ok: false, reason: 'malformed' });
    expect(read()).toBe('note = """\nconfirmedByMason = false\n"""\n');
  });

  it('keeps the previous bytes in comms.toml.bak with private permissions', () => {
    write(COMMS);
    const { digest } = readCommsLimits(dir);
    expect(confirmCommsLimits(dir, { limitsDigest: digest!, confirmedAt: AT }).ok).toBe(true);
    expect(readFileSync(join(dir, 'comms.toml.bak'), 'utf8')).toBe(COMMS);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'comms.toml.bak')).mode & 0o777).toBe(0o600);
  });
});

