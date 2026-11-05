/** Bounded, read-only evidence for the current iMessage path. */
import { loadConfigReadOnlyStrict } from '../config.js';
import { commsEnabled, probeChatDb, readCursor, type ChatDbState } from '../integrations/imessage.js';
import type { AshlrConfig } from '../types.js';

type Finding = { state: string; reason: string; nextStep: string };
export interface IMessagePathDeps {
  platform?: string;
  config?: () => AshlrConfig;
  probe?: () => ChatDbState;
  cursor?: (runsRoot?: string) => number | null;
  runsRoot?: string;
}
const finding = (state: string, reason: string, nextStep: string): Finding => ({ state, reason, nextStep });

export function checkIMessagePath(deps: IMessagePathDeps = {}) {
  const platform = deps.platform ?? process.platform;
  let cfg: AshlrConfig | null = null;
  try { cfg = (deps.config ?? loadConfigReadOnlyStrict)(); } catch { /* Fixed output only. */ }
  let db: ChatDbState | null = null;
  if (platform === 'darwin') {
    try { db = (deps.probe ?? probeChatDb)(); } catch { /* Evidence unavailable. */ }
  }
  let cursor: number | null = null;
  try { cursor = (deps.cursor ?? readCursor)(deps.runsRoot); } catch { /* Evidence unavailable. */ }
  const validCursor = typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor >= 0;
  const enabled = cfg === null ? null : commsEnabled(cfg);
  return {
    schema: 'fleet.imessage-path.v1',
    platform: platform === 'darwin'
      ? finding('supported', 'MACOS', 'Run phm imessage doctor --json for local permission evidence.')
      : finding('unsupported', 'PLATFORM_UNSUPPORTED', 'Run this diagnostic on the Mac hosting Messages.'),
    configuration: enabled === null
      ? finding('unknown', 'CONFIG_UNAVAILABLE', 'Run phm imessage doctor --json and inspect configuration locally.')
      : enabled ? finding('configured', 'CONFIG_ENABLED', 'Run phm imessage doctor --json to inspect permissions.')
        : finding('disabled', 'CONFIG_DISABLED_OR_INCOMPLETE', 'Run phm imessage doctor --json to inspect configuration.'),
    chatDb: platform !== 'darwin' ? finding('unknown', 'DB_NOT_PROBED', 'Run phm imessage doctor --json on the Messages Mac.')
      : db === 'ok' ? finding('readable', 'DB_READABLE', 'Run phm imessage doctor --json for remaining checks.')
        : db === 'blocked_full_disk_access' ? finding('unavailable', 'DB_ACCESS_BLOCKED', 'Review Full Disk Access for the responsible app; run phm imessage doctor --json.')
          : finding('unavailable', db === 'missing' ? 'DB_MISSING_OR_UNREADABLE' : 'DB_PROBE_UNAVAILABLE', 'Run phm imessage doctor --json on the Messages Mac.'),
    cursor: validCursor ? finding('present', 'CURSOR_BASELINE_PRESENT', 'Run phm imessage poll --json to inspect intake counts.')
      : finding('unknown', 'CURSOR_UNAVAILABLE', 'Run phm imessage poll --json to inspect intake counts and review baseline setup.'),
    transport: finding('owner_only', 'SELF_ONLY_TRANSPORT', 'Use phm imessage doctor --json to inspect owner-channel evidence.'),
    ownerReply: finding('unknown', 'OWNER_DELIVERY_NOT_VERIFIED', 'Run phm imessage doctor --json; configuration alone does not prove delivery.'),
    collaboratorIntake: finding('unsupported', 'VERIFIED_OWNER_ONLY', 'The current bridge accepts only verified Mason as operator.'),
    collaboratorDelivery: finding('unsupported', 'SELF_ONLY_TRANSPORT', 'A collaborator-capable transport is required; an intake allowlist does not authorize sending.'),
  };
}
