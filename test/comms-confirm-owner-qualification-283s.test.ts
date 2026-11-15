/**
 * RQ-PHX-CONFIRMOWNERQUALIFY283S -- preservation evidence for the EXISTING
 * owner PR #5354 (RQ-PHX-COMMSCONFIRMORIGINAL264S, head
 * 4e14679113465df935a470b65ba1a345e7945def), a recut of original PR #4332
 * (head 4362a36ce271b7e0132926fcd365c4b7aa902096). Supporting evidence only:
 * no implementation, no CLI/MCP writer, no send-policy change.
 *
 * The owner suites (test/comms-confirm-original-264s.test.ts,
 * test/comms-confirm-http-original-264s.test.ts) already prove the
 * digest-mismatch refusal parses back to unconfirmed and leaves no
 * comms.toml.bak. What they do NOT prove is the stronger no-write contract
 * this suite adds: when the `[team].identities` snapshot in
 * agent-network.toml changes after Mason loads the limits, a confirm clicked
 * with the stale digest must leave EVERY directory entry and EVERY file byte
 * in the config dir identical -- including agent-network.toml itself and any
 * stray `*.tmp` a partial write could leave -- and the refusal must not be
 * sticky: the new snapshot's own digest still confirms normally afterwards.
 *
 * src/core/comms/comms-confirm.ts exists only on the owner branch, so the
 * suite self-skips on trees without it (e.g. master before #5354 merges).
 * Temporary fake config dirs only; no real account files, network or
 * credentials.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCommsConfirmation } from '../src/core/agents/channel-policy.js';

const MODULE_TS = fileURLToPath(new URL('../src/core/comms/comms-confirm.ts', import.meta.url));
const hasOwnerModule = existsSync(MODULE_TS);

const AT = '2026-11-13T00:00:00.000Z';
const NETWORK_V1 = '[team]\nidentities = [{ channel = "slack", id = "U0FAKE0001" }, { channel = "imessage", id = "imessage:0123456789abcdef" }]\n';
const NETWORK_V2 = '[team]\nidentities = [{ channel = "slack", id = "U0FAKE9999" }]\n';
const COMMS = 'confirmedByMason = false\n[limits]\nmaxPerDay = 3\n';

interface CommsConfirmModule {
  readCommsLimits(dir: string): { state: string; digest: string | null };
  confirmCommsLimits(dir: string, input: { limitsDigest: string; confirmedAt: string }):
    { ok: true; confirmedAt: string } | { ok: false; reason: string };
}

async function loadModule(): Promise<CommsConfirmModule> {
  return (await import('../src/core/comms/comms-confirm.js')) as CommsConfirmModule;
}

interface DirEntry { name: string; kind: string; bytes: string | null }
function snapshotDir(dir: string): DirEntry[] {
  return readdirSync(dir, { withFileTypes: true })
    .map(entry => ({
      name: entry.name,
      kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other',
      bytes: entry.isFile() ? readFileSync(join(dir, entry.name), 'utf8') : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe.skipIf(!hasOwnerModule)('owner PR #5354 comms-confirm preservation (283s)', () => {
  let dir: string;
  let mod: CommsConfirmModule;

  beforeEach(async () => {
    mod = await loadModule();
    dir = mkdtempSync(join(tmpdir(), 'comms-confirm-qualify-283s-'));
    writeFileSync(join(dir, 'agent-network.toml'), NETWORK_V1, { mode: 0o600 });
    writeFileSync(join(dir, 'comms.toml'), COMMS, { mode: 0o600 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a stale-digest confirm after a team-identity change writes nothing: every entry and byte identical', async () => {
    const staleDigest = mod.readCommsLimits(dir).digest!;
    // The team allowlist is part of the reviewed limits; changing it must move the digest.
    writeFileSync(join(dir, 'agent-network.toml'), NETWORK_V2, { mode: 0o600 });
    expect(mod.readCommsLimits(dir).digest).not.toBe(staleDigest);

    const before = snapshotDir(dir);
    const result = mod.confirmCommsLimits(dir, { limitsDigest: staleDigest, confirmedAt: AT });
    expect(result).toEqual({ ok: false, reason: 'digest-mismatch' });

    expect(snapshotDir(dir)).toEqual(before);
    expect(readFileSync(join(dir, 'comms.toml'), 'utf8')).toBe(COMMS);
    expect(readFileSync(join(dir, 'agent-network.toml'), 'utf8')).toBe(NETWORK_V2);
    expect(parseCommsConfirmation(COMMS)).toBe(false);
  });

  it('the refusal is not sticky: the changed snapshot confirms under its own digest', async () => {
    const staleDigest = mod.readCommsLimits(dir).digest!;
    writeFileSync(join(dir, 'agent-network.toml'), NETWORK_V2, { mode: 0o600 });
    expect(mod.confirmCommsLimits(dir, { limitsDigest: staleDigest, confirmedAt: AT }))
      .toEqual({ ok: false, reason: 'digest-mismatch' });

    const freshDigest = mod.readCommsLimits(dir).digest!;
    expect(mod.confirmCommsLimits(dir, { limitsDigest: freshDigest, confirmedAt: AT }))
      .toEqual({ ok: true, confirmedAt: AT });
    expect(mod.readCommsLimits(dir)).toMatchObject({ state: 'confirmed', confirmedAt: AT });
  });
});
