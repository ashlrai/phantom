/**
 * core/connect/services.ts: the vendor service catalog for `phm connect`.
 *
 * Each entry declares:
 *   - a status probe (argv only; detects a live sign-in, parses a value-free
 *     account label). Discovery NEVER reads token or session file contents.
 *   - the vendor's own device-code/OAuth login argv (run on the target node).
 *   - an optional token-mint argv (prints a scoped token on stdout; the value
 *     is captured and vaulted, never displayed).
 *   - session-file paths relative to $HOME, used ONLY by the last-resort
 *     sealed session copy (existence-checked; contents read only at seal time
 *     and only ever into the encrypted bundle).
 *
 * HARD EXCEPTION: the CMP Codex session (~/.codex) is excluded from copy,
 * move and rotation. `codex` has no sessionFiles entries and
 * sessionCopyProhibitedReason is set; `assertSessionCopyAllowed` also refuses
 * any path under ~/.codex defensively, independent of this table.
 */

import { join, normalize, sep } from 'node:path';
import type {
  ConnectProbeResult,
  ConnectServiceId,
  ConnectServiceSpec,
} from './types.js';

// ---------------------------------------------------------------------------
// Probe helpers
// ---------------------------------------------------------------------------

function both(result: ConnectProbeResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function ok(result: ConnectProbeResult): boolean {
  return result.error === undefined && result.status === 0;
}

function firstMatch(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m?.[1]?.trim() || null;
}

function jsonField(result: ConnectProbeResult, key: string): string | null {
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const v = (parsed as Record<string, unknown>)[key];
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
    }
  } catch { /* malformed status output */ }
  return null;
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export const CONNECT_SERVICES: readonly ConnectServiceSpec[] = [
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    scopes: ['chatgpt-account'],
    probe: {
      argv: ['codex', 'login', 'status'],
      timeoutMs: 8_000,
      signedIn: (r) => ok(r) && /logged in/i.test(both(r)),
      account: (r) => firstMatch(both(r), /(?:account|user|email|as)[:\s]+([^\s]+)/i),
    },
    deviceLogin: ['codex', 'login'],
    tokenMint: null,
    sessionFiles: [],
    sessionCopyProhibitedReason:
      'the CMP Codex session (~/.codex) is excluded from copy, move and rotation',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    scopes: ['anthropic-account'],
    probe: {
      argv: ['claude', 'auth', 'status'],
      timeoutMs: 8_000,
      signedIn: (r) => ok(r) && /"loggedIn":\s*true/.test(r.stdout),
      account: (r) => jsonField(r, 'email') ?? jsonField(r, 'authMethod'),
    },
    deviceLogin: ['claude', 'auth', 'login'],
    tokenMint: null,
    sessionFiles: ['.claude/.credentials.json'],
    sessionCopyProhibitedReason: null,
  },
  {
    id: 'gh',
    label: 'GitHub CLI',
    scopes: ['repo', 'read:org', 'workflow'],
    probe: {
      argv: ['gh', 'auth', 'status'],
      timeoutMs: 8_000,
      signedIn: (r) => ok(r) && /logged in/i.test(both(r)),
      account: (r) => firstMatch(both(r), /account\s+([^\s(]+)/i),
    },
    deviceLogin: ['gh', 'auth', 'login', '--web'],
    tokenMint: ['gh', 'auth', 'token'],
    sessionFiles: [join('.config', 'gh', 'hosts.yml')],
    sessionCopyProhibitedReason: null,
  },
  {
    id: 'devin',
    label: 'Devin CLI',
    scopes: ['devin-account'],
    probe: {
      argv: ['devin', 'auth', 'status'],
      timeoutMs: 8_000,
      signedIn: (r) => ok(r) && /logged in/i.test(both(r)),
      account: (r) => firstMatch(both(r), /Name:\s+([^\s]+)/i),
    },
    deviceLogin: ['devin', 'auth', 'login'],
    tokenMint: null,
    sessionFiles: [join('.local', 'share', 'devin', 'credentials.toml')],
    sessionCopyProhibitedReason: null,
  },
  {
    id: 'grok',
    label: 'Grok Build CLI',
    scopes: ['grok-account'],
    probe: {
      argv: ['grok', 'models'],
      timeoutMs: 8_000,
      signedIn: (r) => ok(r) && !/not authenticated|not logged in/i.test(both(r)),
      account: () => null,
    },
    deviceLogin: ['grok', 'login', '--device-auth'],
    tokenMint: null,
    sessionFiles: [join('.grok', 'auth.json'), join('.grok', 'credentials.json')],
    sessionCopyProhibitedReason: null,
  },
  {
    id: 'gcloud',
    label: 'Google Cloud CLI',
    scopes: ['cloud-platform'],
    probe: {
      argv: ['gcloud', 'auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'],
      timeoutMs: 10_000,
      signedIn: (r) => ok(r) && r.stdout.trim() !== '',
      account: (r) => r.stdout.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? null,
    },
    deviceLogin: ['gcloud', 'auth', 'login'],
    tokenMint: ['gcloud', 'auth', 'print-access-token'],
    sessionFiles: [join('.config', 'gcloud')],
    sessionCopyProhibitedReason: null,
  },
  {
    id: 'vercel',
    label: 'Vercel CLI',
    scopes: ['vercel-account'],
    probe: {
      argv: ['vercel', 'whoami'],
      timeoutMs: 8_000,
      signedIn: (r) => ok(r) && r.stdout.trim() !== '',
      account: (r) =>
        r.stdout.split('\n').map((l) => l.trim())
          .filter((l) => l !== '' && !/^vercel cli/i.test(l))
          .pop() ?? null,
    },
    deviceLogin: ['vercel', 'login'],
    tokenMint: null,
    sessionFiles: [
      join('.local', 'share', 'com.vercel.cli', 'auth.json'),
      join('Library', 'Application Support', 'com.vercel.cli', 'auth.json'),
    ],
    sessionCopyProhibitedReason: null,
  },
  {
    id: 'supabase',
    label: 'Supabase CLI',
    scopes: ['supabase-account'],
    probe: {
      argv: ['supabase', 'projects', 'list'],
      timeoutMs: 10_000,
      signedIn: (r) => ok(r) && !/access token not provided|not logged in|unauthorized/i.test(both(r)),
      account: () => null,
    },
    deviceLogin: ['supabase', 'login'],
    tokenMint: null,
    sessionFiles: [join('.supabase', 'access-token')],
    sessionCopyProhibitedReason: null,
  },
  {
    // Pseudo-service: configured MCP servers discovered from client config
    // files (names + commands only; env values are never surfaced).
    id: 'mcp',
    label: 'MCP servers',
    scopes: ['mcp-servers'],
    probe: null,
    deviceLogin: null,
    tokenMint: null,
    sessionFiles: [],
    sessionCopyProhibitedReason: null,
  },
];

const BY_ID = new Map<ConnectServiceId, ConnectServiceSpec>(
  CONNECT_SERVICES.map((s) => [s.id, s]),
);

export function getConnectService(id: string): ConnectServiceSpec | null {
  return BY_ID.get(id as ConnectServiceId) ?? null;
}

export function isConnectServiceId(id: string): id is ConnectServiceId {
  return BY_ID.has(id as ConnectServiceId);
}

// ---------------------------------------------------------------------------
// The ~/.codex exclusion (HARD EXCEPTION)
// ---------------------------------------------------------------------------

/**
 * Relative-to-home session paths that can never be copied, moved or rotated
 * by `phm connect`, independent of the service table. The CMP Codex session
 * (~/.codex) is the operator's own running context; exporting it would ship
 * the operator session to another node.
 */
export const CONNECT_EXCLUDED_SESSION_PATHS: readonly string[] = ['.codex'];

function normalizeRelativeHomePath(rel: string): string {
  return normalize(rel).replace(/^[./\\]+/, '');
}

/**
 * True when `rel` (a home-relative path) is ~/.codex itself or anything under
 * it. Case-insensitive on case-insensitive filesystems is handled by callers
 * comparing realpaths; here we compare normalized segments.
 */
export function isExcludedSessionPath(rel: string): boolean {
  const normalized = normalizeRelativeHomePath(rel);
  if (normalized === '') return false;
  const segments = normalized.split(sep);
  const first = segments[0];
  return CONNECT_EXCLUDED_SESSION_PATHS.some((excluded) => {
    const excludedSegments = normalizeRelativeHomePath(excluded).split(sep);
    if (segments.length < excludedSegments.length) return false;
    return excludedSegments.every((seg, i) => segments[i] === seg) && first === excludedSegments[0];
  });
}

/**
 * Refuse session-file copy/move/rotation for a service or path that is
 * excluded. Returns a value-free reason string, or null when allowed.
 * This is the single gate every session-copy path must pass through.
 */
export function sessionCopyRefusal(serviceId: ConnectServiceId, rel: string): string | null {
  const service = getConnectService(serviceId);
  if (service?.sessionCopyProhibitedReason) return service.sessionCopyProhibitedReason;
  if (isExcludedSessionPath(rel)) {
    return `~/${normalizeRelativeHomePath(rel)} is inside the CMP Codex session (~/.codex): excluded from copy, move and rotation`;
  }
  return null;
}
