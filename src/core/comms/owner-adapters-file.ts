/**
 * The owner adapter config (~/.ashlr/comms/owner-adapters.toml): create the
 * starter when it is missing, and flip the one iMessage key. Writes only
 * fixed plain text: no secret, id, number or address ever goes in. An
 * existing file is never overwritten; enable/disable touch only
 * `[imessage] bridge`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';

export const OWNER_ADAPTERS_FILE = 'owner-adapters.toml';

/** iMessage needs no secret, so it starts on. The other channels start off. */
export const STARTER_OWNER_ADAPTERS = `# Which phone channels Phantom may use to reach Mason. Edit with: phm owner-live enable|disable imessage
[imessage]
# Local bridge, no secret needed. Remove this line or run phm owner-live disable imessage to turn it off.
bridge = "loopback"

[telegram]
# Off until you name the Phantom Secrets handle.
# secretHandle = "phm_TELEGRAM_BOT_TOKEN"

[email]
# Off until you name the Phantom Secrets handle.
# secretHandle = "phm_EMAIL_CREDENTIAL"

[slack]
# Off until you name the Phantom Secrets handle.
# secretHandle = "phm_SLACK_BOT_TOKEN"
`;

export interface EnsureResult { file: string; created: boolean }

/** Write the starter only when no file exists (flag wx: an existing file is never touched). */
export function ensureOwnerAdaptersFile(configDir: string): EnsureResult {
  const dir = join(configDir, 'comms');
  const file = join(dir, OWNER_ADAPTERS_FILE);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, STARTER_OWNER_ADAPTERS, { flag: 'wx', mode: 0o600 });
    return { file, created: true };
  } catch {
    return { file, created: false };
  }
}

export interface SetBridgeResult { file: string; changed: boolean; bridge: 'loopback' | 'off' }

/**
 * Turn iMessage on (`bridge = "loopback"`) or off (`bridge = "off"`), editing
 * only that key. Other lines, comments and sections are kept byte for byte.
 */
export function setImessageBridge(configDir: string, on: boolean): SetBridgeResult {
  const { file } = ensureOwnerAdaptersFile(configDir);
  const value = on ? 'loopback' : 'off';
  const text = readFileSync(file, 'utf8');
  let original = parse('');
  try { original = parse(text); } catch { throw new Error('Cannot switch iMessage: invalid owner adapters TOML'); }
  const section = original.imessage;
  if (section !== undefined && (section === null || typeof section !== 'object' || Array.isArray(section) || section instanceof Date)) {
    throw new Error('Cannot switch iMessage: imessage is not a table');
  }
  const expected = parse(text);
  const table = (expected.imessage ??= Object.create(null)) as Record<string, unknown>;
  if (table.bridge === value) return { file, changed: false, bridge: value };
  table.bridge = value;

  // Try bounded, single-line edits, and let the same TOML parser used by the
  // settings reader prove that no other parsed setting changed. Unsupported
  // shapes (such as inline tables or multiline values) fail closed.
  const lines = text.split('\n');
  const candidates: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const assignment = /^(\s*[^#\r\n]+?\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^#\s]+)(\s*(?:#.*)?\r?)$/.exec(raw);
    if (assignment) {
      const copy = lines.slice();
      copy[i] = `${assignment[1]}"${value}"${assignment[3]}`;
      candidates.push(copy.join('\n'));
    }
    if (/^\s*\[/.test(raw)) {
      const copy = lines.slice();
      copy.splice(i + 1, 0, `bridge = "${value}"${raw.endsWith('\r') ? '\r' : ''}`);
      candidates.push(copy.join('\n'));
    }
  }
  candidates.push(`${text}${text && !text.endsWith('\n') ? '\n' : ''}\n[imessage]\nbridge = "${value}"\n`);
  const next = candidates.find(candidate => {
    try { return isDeepStrictEqual(parse(candidate), expected); } catch { return false; }
  });
  if (next === undefined) throw new Error('Cannot switch iMessage: no safe TOML edit found');
  writeFileSync(file, next, { mode: 0o600 });
  return { file, changed: true, bridge: value };
}
