import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { cooldownActive, parseCliCooldown } from '../core/providers/coding-cli/limits.js';

/** Largest captured-output file read. Longer input is refused, never truncated. */
export const COOLDOWN_EVIDENCE_MAX_BYTES = 64 * 1024;
const BACKEND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Strict ISO-8601 with an explicit offset; Date.parse alone accepts looser forms.
const NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const usage = `Usage: phm fleet cooldown-evidence --backend <label> --file <absolute-path> --now <ISO-8601> [--json]
Reads one captured CLI output file (at most ${COOLDOWN_EVIDENCE_MAX_BYTES} bytes) and reports any rate-limit cooldown it shows
at the observation time. Read-only: no provider process, network, credentials, log discovery or writes.
A missing limit line is not proof of remaining allowance; this checks no live quota, assignment or account availability.`;

/** Fixed messages only: raw errno text and the path are never printed. */
async function readCapture(path: string): Promise<{ text: string } | { error: string }> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code ?? '';
    const messages: Record<string, string> = {
      ELOOP: 'unsafe input: symbolic links are refused', EMLINK: 'unsafe input: symbolic links are refused',
      ENOENT: 'input file not found', ENOTDIR: 'input file not found',
      EACCES: 'input file is not readable', EPERM: 'input file is not readable',
    };
    return { error: messages[code] ?? 'input file could not be opened' };
  }
  const tooLarge = { error: `input file exceeds ${COOLDOWN_EVIDENCE_MAX_BYTES} bytes` };
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { error: 'unsafe input: not a regular file' };
    if (info.size > COOLDOWN_EVIDENCE_MAX_BYTES) return tooLarge;
    // Read at most cap+1 bytes so a file that grows after stat is still refused.
    const buffer = Buffer.alloc(COOLDOWN_EVIDENCE_MAX_BYTES + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > COOLDOWN_EVIDENCE_MAX_BYTES) return tooLarge;
    }
    const bytes = buffer.subarray(0, total);
    if (bytes.includes(0)) return { error: 'unsafe input: binary content (NUL byte) is refused' };
    return { text: bytes.toString('utf8') };
  } catch {
    return { error: 'input file could not be read' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** `phm fleet cooldown-evidence`. Exit 0 on evaluation (including no limit), 1 on unusable input, 2 on bad arguments. */
export async function cmdFleetCooldownEvidence(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    return 0;
  }
  const flags: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    const value = args[i + 1];
    if (!['--backend', '--file', '--now'].includes(arg) || flags[arg] !== undefined || value === undefined || value === '' || value.startsWith('--')) {
      console.error(usage);
      return 2;
    }
    flags[arg] = value;
    i++;
  }
  const backend = flags['--backend'];
  const file = flags['--file'];
  const now = flags['--now'];
  if (backend === undefined || file === undefined || now === undefined) {
    console.error(usage);
    return 2;
  }
  if (!BACKEND.test(backend)) {
    console.error('error: --backend must be a plain identifier (letters, digits, ., _, -; up to 64 characters)');
    return 2;
  }
  if (!isAbsolute(file) || file.length > 4096 || file.includes('\0')) {
    console.error('error: --file must be an absolute path to a captured output file');
    return 2;
  }
  const nowMs = NOW.test(now) && now.length <= 40 ? Date.parse(now) : Number.NaN;
  if (!Number.isFinite(nowMs)) {
    console.error('error: --now must be an ISO-8601 timestamp with a time zone (for example 2026-11-19T12:00:00Z)');
    return 2;
  }

  const read = await readCapture(file);
  if ('error' in read) {
    if (json) console.log(JSON.stringify({ schema: 'fleet.cooldown-evidence.v1', advisory: true, authority: 'none', error: read.error }));
    else console.error(`error: ${read.error}`);
    return 1;
  }

  const observedAt = new Date(nowMs).toISOString();
  const cooldown = parseCliCooldown(backend, read.text, nowMs);
  const resetAt = cooldown?.untilMs != null ? new Date(cooldown.untilMs).toISOString() : null;
  const resetKnown = resetAt !== null; const reportedLimit = cooldown !== null;
  const activeAtObservation = cooldownActive(cooldown, nowMs);
  const interpretation = !reportedLimit ? 'no-limit-line-in-capture'
    : resetKnown ? 'limit-with-known-future-reset' : 'limit-with-unknown-reset';

  if (json) {
    console.log(JSON.stringify({
      schema: 'fleet.cooldown-evidence.v1', advisory: true, authority: 'none', source: 'captured-output', backend,
      observedAt, reportedLimit, resetAt, resetKnown, activeAtObservation, interpretation, allowanceProven: false, live: false,
    }));
  } else {
    console.log(`fleet cooldown-evidence (captured-output, advisory, no authority): backend=${backend}`);
    console.log(`limit reported: ${reportedLimit ? 'yes' : 'no'}; reset: ${resetAt ?? 'unknown'}; active at ${observedAt}: ${activeAtObservation ? 'yes' : 'no'}`);
    console.log('no limit line is not proof of remaining allowance; this reads one capture and checks no live quota.');
  }
  return 0;
}
