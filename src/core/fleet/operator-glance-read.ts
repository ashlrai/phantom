/**
 * Filesystem reader for the operator glance. The pure shape lives in
 * operator-glance.ts so the phone can render it without this module.
 */
import { constants } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync, lstatSync, readdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildCodexResourceReport, collectCodexSessionUsages } from './codex-session-usage.js';
import { readEmailDropConfig } from '../comms/email-drop-config.js';
import { readFleetRunsDirState } from './runs-dir-state.js';
import { scrubSecrets } from '../util/scrub.js';
import { readGuardianGlance } from './guardian-glance.js';
import { readOperatorSecret, secretsMatch } from './operator-proof.js';
import { buildOperatorGlance, type OperatorGlance } from './operator-glance.js';

import { readAppsRecoveryInvocations } from './apps-recovery-invocations.js';
import { appsRecoveryIncident } from './apps-recovery-glance.js';

const MAX_BYTES = 32 * 1024;

async function readFileBounded(path: string): Promise<string | null> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_BYTES) return null;
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    return scrubSecrets(bytes.subarray(0, offset).toString('utf8'));
  } finally {
    await file.close();
  }
}

async function newestStatus(runsDir: string): Promise<string | null> {
  const dir = join(runsDir, 'supervisor');
  let names: string[];
  try {
    if (!lstatSync(dir).isDirectory()) return null;
    names = readdirSync(dir).filter((name) => /^status-[A-Za-z0-9._-]{1,80}\.md$/.test(name)).sort();
  } catch {
    return null;
  }
  let best: { name: string; mtime: number } | null = null;
  for (const name of names.slice(0, 64)) {
    try {
      const info = lstatSync(join(dir, name));
      if (!info.isFile()) continue;
      if (!best || info.mtimeMs >= best.mtime) best = { name, mtime: info.mtimeMs };
    } catch { /* skip unreadable names */ }
  }
  return best ? readFileBounded(join(dir, best.name)) : null;
}

function codexUsage(nowMs: number): { usedPct: number | null; resetsAt: string | null } {
  try {
    const home = homedir();
    const personalHome = join(home, '.codex-2');
    const usages = collectCodexSessionUsages({ env: { CODEX_HOME: personalHome, CODEX_HOME_ALT: personalHome }, homeDir: home });
    const report = buildCodexResourceReport(usages.map((usage) => ({ ...usage, accountId: 'codex-personal', slot: 'secondary' as const })), [], nowMs);
    const account = report.resources.find((resource) => resource.state === 'current' && resource.weekly?.usedPct != null
      && (resource.weekly.windowMinutes === null || resource.weekly.windowMinutes > 315)
      && resource.observedAt !== null && Date.parse(resource.observedAt) <= nowMs);
    if (!account?.weekly) return { usedPct: null, resetsAt: null };
    return { usedPct: account.weekly.usedPct, resetsAt: account.weekly.resetsAt };
  } catch {
    return { usedPct: null, resetsAt: null };
  }
}

export async function readOperatorGlance(opts: { runsDir?: string; busRoot?: string; now?: () => Date } = {}): Promise<OperatorGlance> {
  const now = opts.now ?? (() => new Date());
  const at = now();
  const runsDir = opts.runsDir ?? join(homedir(), '.ashlr-runs');
  const state = await readFleetRunsDirState({ runsDir, now: () => at.getTime() }).catch(() => null);
  const usage = codexUsage(at.getTime());
  const guardian = await readGuardianGlance(runsDir, at.getTime());
  let recoveryIncident: string | null = null;
  try {
    const busRoot = opts.busRoot ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
    recoveryIncident = appsRecoveryIncident(readAppsRecoveryInvocations(busRoot), at.getTime());
  } catch { /* unavailable recovery evidence stays quiet */ }
  const glance = buildOperatorGlance({
    now: at,
    lanes: state?.lanes ?? [],
    switches: state?.switches ?? [],
    claudeLane: state?.claudeLane ?? null,
    usagePct: usage.usedPct,
    resetsAt: usage.resetsAt,
    mainText: await newestStatus(runsDir),
    incidentText: [
      recoveryIncident,
      await readFileBounded(join(runsDir, 'NEEDS-MASON.md')),
      await readFileBounded(join(runsDir, 'leader', 'INCIDENTS.md'))
    ].filter((text): text is string => text != null).join('\n') || null,
  });
  return guardian.length > 0 ? { ...glance, guardian } : glance;
}

/** Existing private pairing, or an explicit /pair code from the configured owner. */
export function acceptTelegramPair(userId: number, runsDir = join(homedir(), '.ashlr-runs'), code?: string): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  const path = join(runsDir, 'queue', 'telegram-pair.json');
  try {
    const info = lstatSync(path);
    if (!info.isFile()) return false;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return !!parsed && typeof parsed === 'object' && (parsed as { userId?: unknown }).userId === userId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  const secret = readOperatorSecret();
  if (!code || secret.state !== 'ready' || !secret.secret || !secretsMatch(code, secret.secret)) return false;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify({ v: 1, userId })}\n`, { mode: 0o600, flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return !!parsed && typeof parsed === 'object' && (parsed as { userId?: unknown }).userId === userId;
    } catch {
      return false;
    }
  }
}

export function emailPaired(address: string, runsDir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(runsDir, 'queue', 'email-paired.json'), 'utf8'));
    const addresses = parsed && typeof parsed === 'object' ? (parsed as { addresses?: unknown }).addresses : null;
    return Array.isArray(addresses) && addresses.includes(address);
  } catch {
    return false;
  }
}

export function rememberEmailPair(address: string, runsDir: string): void {
  const path = join(runsDir, 'queue', 'email-paired.json');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let addresses: string[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const current = parsed && typeof parsed === 'object' ? (parsed as { addresses?: unknown }).addresses : null;
    if (Array.isArray(current)) addresses = current.filter((item): item is string => typeof item === 'string');
  } catch { /* a new file starts empty */ }
  if (!addresses.includes(address)) addresses.push(address);
  writeFileSync(path, `${JSON.stringify({ v: 1, addresses: addresses.slice(-8) })}\n`, { mode: 0o600 });
}

/** One short note in the email outbox. No outbox means no mail, and this never throws. */
export async function writeSignificantEmail(text: string, runsDir = join(homedir(), '.ashlr-runs')): Promise<void> {
  try {
    const config = await readEmailDropConfig(runsDir);
    if (config.state !== 'ok' || !config.config?.outboxDir || !config.config.from[0]) return;
    const to = config.config.from[0];
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    mkdirSync(config.config.outboxDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(config.config.outboxDir, `operator-${id}.eml`),
      `To: ${to}\r\nSubject: Phantom\r\nMessage-ID: <${id}@phantom.local>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`,
      { mode: 0o600, flag: 'wx' });
  } catch { /* a missing outbox stays quiet */ }
}
