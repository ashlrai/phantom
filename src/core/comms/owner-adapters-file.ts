/**
 * The owner adapter config (~/.ashlr/comms/owner-adapters.toml): create the
 * starter when it is missing, and flip the one iMessage key. Writes only
 * fixed plain text: no secret, id, number or address ever goes in. An
 * existing file is never overwritten; enable/disable touch only
 * `[imessage] bridge`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  const lines = text.split('\n');
  const line = `bridge = "${value}"`;
  let section = '';
  let sectionAt = -1;
  let keyAt = -1;
  lines.forEach((raw, i) => {
    const head = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(raw);
    if (head) { section = head[1]!.trim(); if (section === 'imessage' && sectionAt < 0) sectionAt = i; return; }
    if (section === 'imessage' && keyAt < 0 && /^\s*bridge\s*=/.test(raw)) keyAt = i;
  });
  if (keyAt >= 0) lines[keyAt] = line;
  else if (sectionAt >= 0) lines.splice(sectionAt + 1, 0, line);
  else lines.push('', '[imessage]', line, '');
  const next = lines.join('\n');
  if (next === text) return { file, changed: false, bridge: value };
  writeFileSync(file, next, { mode: 0o600 });
  return { file, changed: true, bridge: value };
}
