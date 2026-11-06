/**
 * core/verse/desktop-adapters.ts — per-app adapters over desktop control
 * (RQ-DESK-2): start a task, read its status, collect its result, in the
 * Devin, Claude and Codex desktop apps, plus a self-drive adapter Phantom's
 * own smoke test uses.
 *
 * NOTHING HERE TOUCHES THE DESKTOP DIRECTLY. The three app adapters speak only
 * through the `computer_*` tools (verse-mcp-computer.ts) via a `ToolCall`, so
 * every gate stays in force: the operator's per-chat grant, tier ceilings, the
 * probe + confirmation card (a "Send" press still asks), secure-field refusal,
 * takeover and KILL. An adapter cannot widen access; it only sequences calls.
 * No tool call is made to read or write the MACCU TCC helper.
 *
 * PHANTOM IS NOT DRIVEN THROUGH THE SCREEN. `ai.ashlr.desktop` is on the hard
 * denylist (an agent must never approve its own grants), so self-drive uses
 * Phantom's own loopback Verse API through an injected `request`, which keeps
 * the mutation token out of this module.
 *
 * Text read off a window is someone else's words: `collect()` returns it
 * scrubbed, capped and flagged `untrusted: true` for the caller to frame.
 */
import { scrubSecrets } from '../util/scrub.js';
import { computerAppPolicy } from './computer-types.js';
import type { VerseMcpToolResult } from './verse-mcp-computer.js';

export type DesktopAppId = 'devin' | 'claude' | 'codex';
export type DesktopTaskState = 'idle' | 'working' | 'needs-input' | 'unknown';

export interface DesktopStatus {
  state: DesktopTaskState;
  /** Controls the state was inferred from (labels only, never window text). */
  signals: string[];
}

export type DesktopStartResult = { ok: true; handle: string } | { ok: false; error: string };
export type DesktopCollectResult =
  | { ok: true; text: string; truncated: boolean; untrusted: boolean }
  | { ok: false; error: string };

export interface DesktopAdapter {
  readonly id: string;
  start(task: string): Promise<DesktopStartResult>;
  status(handle: string): Promise<DesktopStatus>;
  collect(handle: string): Promise<DesktopCollectResult>;
}

/** One `computer_*` tool call for the chat that owns the adapter. */
export type ToolCall = (name: string, args: Record<string, unknown>) => Promise<VerseMcpToolResult>;

export const MAX_TASK_CHARS = 2000;
export const MAX_COLLECT_CHARS = 8000;

// ---------------------------------------------------------------------------
// Per-app profiles
// ---------------------------------------------------------------------------

export interface DesktopAppProfile {
  id: DesktopAppId;
  /** Exact (case-insensitive) running-app names. */
  names: readonly string[];
  /** Bundle ids tried before names. UNVERIFIED against a live install: name match is the fallback. */
  bundleIds: readonly string[];
  composer: RegExp;
  send: RegExp;
  stop: RegExp;
  approval: RegExp | null;
}

export const DESKTOP_APP_PROFILES: Readonly<Record<DesktopAppId, DesktopAppProfile>> = {
  claude: {
    id: 'claude', names: ['Claude'], bundleIds: ['com.anthropic.claudefordesktop'],
    composer: /write|message|reply|ask|prompt|help/i, send: /^send( message)?$/i, stop: /^stop( response| generating)?$/i, approval: /^(allow|deny)( once| always)?$/i,
  },
  codex: {
    id: 'codex', names: ['Codex'], bundleIds: ['com.openai.codex'],
    composer: /ask|message|task|follow.?up|prompt|codex/i, send: /^(send|submit|run)$/i, stop: /^(stop|interrupt|cancel)/i, approval: /^(approve|allow|deny|reject)/i,
  },
  devin: {
    id: 'devin', names: ['Devin'], bundleIds: ['ai.cognition.devin', 'com.cognition.devin'],
    composer: /task|message|describe|ask|prompt|devin/i, send: /^(send|submit|start|create)/i, stop: /^(stop|pause|cancel)/i, approval: null,
  },
};

// ---------------------------------------------------------------------------
// Reading tool output
// ---------------------------------------------------------------------------

export interface AxEntry {
  ref: string;
  role: string;
  title: string;
  description: string;
  value: string;
  enabled: boolean;
  focused: boolean;
}

function toText(result: VerseMcpToolResult): string {
  return result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
}

/**
 * Parse `computer_ax_tree` text (formatAxNode lines) into entries. Lines that
 * are not nodes (headers, the untrusted frame) simply do not match.
 */
export function parseAxTree(text: string): AxEntry[] {
  const out: AxEntry[] = [];
  const quoted = String.raw`"((?:[^"\\]|\\.)*)"`;
  for (const raw of text.split('\n')) {
    const m = /^\s*(e\d{1,5}) (AX\w+)(?: \([^)]*\))?(.*)$/.exec(raw);
    if (!m) continue;
    const rest = m[3] ?? '';
    const unq = (s: string | undefined): string => {
      if (s === undefined) return '';
      try {
        return String(JSON.parse(`"${s}"`));
      } catch {
        return s;
      }
    };
    const title = new RegExp(`^\\s*${quoted}`).exec(rest);
    const description = new RegExp(`desc=${quoted}`).exec(rest);
    const value = new RegExp(`value=${quoted}`).exec(rest);
    out.push({
      ref: m[1]!,
      role: m[2]!,
      title: unq(title?.[1]),
      description: unq(description?.[1]),
      value: rest.includes('[secure') ? '' : unq(value?.[1]),
      enabled: !rest.includes('(disabled)'),
      focused: rest.includes('(focused)'),
    });
  }
  return out;
}

const label = (e: AxEntry): string => e.title || e.description;
const isButton = (e: AxEntry): boolean => e.role === 'AXButton' || e.role === 'AXMenuItem';
const isComposerRole = (e: AxEntry): boolean => e.role === 'AXTextArea' || e.role === 'AXTextField' || e.role === 'AXComboBox';

/** Infer a state from control labels only. Exported for tests. */
export function classifyAx(entries: readonly AxEntry[], profile: DesktopAppProfile): DesktopStatus {
  const signals: string[] = [];
  const buttons = entries.filter(isButton);
  if (profile.approval && buttons.some((e) => e.enabled && profile.approval!.test(label(e).trim()))) signals.push('approval-control');
  if (signals.length > 0) return { state: 'needs-input', signals };
  if (buttons.some((e) => e.enabled && profile.stop.test(label(e).trim())) || entries.some((e) => e.role === 'AXProgressIndicator')) {
    return { state: 'working', signals: ['stop-control'] };
  }
  const send = buttons.some((e) => profile.send.test(label(e).trim()));
  const composer = entries.some((e) => isComposerRole(e) && profile.composer.test(label(e)));
  if (send || composer) return { state: 'idle', signals: [send ? 'send-control' : 'composer'] };
  return { state: 'unknown', signals: [] };
}

function chatText(entries: readonly AxEntry[]): string {
  const parts: string[] = [];
  for (const e of entries) {
    if (isButton(e) || e.role === 'AXSecureTextField') continue;
    const body = e.value.trim() || (e.role === 'AXStaticText' ? e.title.trim() : '');
    if (body && parts[parts.length - 1] !== body) parts.push(body);
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// App adapter
// ---------------------------------------------------------------------------

export interface DesktopAppAdapterOptions {
  /** Override the profile's bundle id (e.g. a beta channel). */
  bundleId?: string;
  /** Tree depth passed to computer_ax_tree (1-12). */
  maxDepth?: number;
}

export type TreeRead = { ok: true; entries: AxEntry[] } | { ok: false; error: string };

async function readTree(call: ToolCall, bundle: string, maxDepth: number): Promise<TreeRead> {
  const res = await call('computer_ax_tree', { app: bundle, max_depth: maxDepth });
  if (res.isError) return { ok: false, error: toText(res).slice(0, 300) };
  return { ok: true, entries: parseAxTree(toText(res)) };
}

/** Read the tree, asking the operator for access once if the chat holds none. */
async function readTreeWithAccess(call: ToolCall, bundle: string, maxDepth: number, reason: string): Promise<TreeRead> {
  let read = await readTree(call, bundle, maxDepth);
  if (!read.ok && /not granted|no desktop access/i.test(read.error)) {
    const asked = await call('computer_request_access', { apps: [bundle], reason });
    if (asked.isError) return { ok: false, error: toText(asked).slice(0, 300) };
    read = await readTree(call, bundle, maxDepth);
  }
  return read;
}

const NOT_RUNNING = (name: string): string => `${name} is not running (or is not granted to this chat). Open it, then ask the operator for access.`;

/** Handle of an app task: the app's bundle id, since each app shows one live conversation. */
export function createDesktopAppAdapter(profile: DesktopAppProfile, call: ToolCall, opts: DesktopAppAdapterOptions = {}): DesktopAdapter {
  const name = profile.names[0]!;
  const maxDepth = opts.maxDepth ?? 10;

  async function resolve(): Promise<string | null> {
    if (opts.bundleId) return opts.bundleId;
    const listed = toText(await call('computer_list_apps', {}));
    for (const line of listed.split('\n')) {
      const m = /^- (.+?) \(([^)]*)\):/.exec(line);
      if (!m) continue;
      const [, appName, bundle] = m;
      if (profile.bundleIds.some((b) => b.toLowerCase() === bundle!.toLowerCase()) || profile.names.some((n) => n.toLowerCase() === appName!.toLowerCase())) {
        return bundle && bundle !== 'no bundle id' ? bundle : null;
      }
    }
    return null;
  }

  const tree = (bundle: string): Promise<TreeRead> => readTree(call, bundle, maxDepth);
  const treeWithAccess = (bundle: string): Promise<TreeRead> => readTreeWithAccess(call, bundle, maxDepth, `Drive the ${name} app for a Phantom task`);

  return {
    id: profile.id,
    async start(task) {
      const text = task.trim();
      if (!text || text.length > MAX_TASK_CHARS || /\p{Cc}/u.test(text.replace(/[\n\t]/g, ' '))) {
        return { ok: false, error: `task must be 1-${MAX_TASK_CHARS} printable characters.` };
      }
      const bundle = await resolve();
      if (!bundle) return { ok: false, error: NOT_RUNNING(name) };
      const read = await treeWithAccess(bundle);
      if (!read.ok) return read;
      const composer = read.entries.find((e) => isComposerRole(e) && e.enabled && profile.composer.test(label(e))) ?? read.entries.find((e) => isComposerRole(e) && e.focused);
      if (!composer) return { ok: false, error: `${name}: no message box found in its accessibility tree.` };
      for (const [tool, args] of [['computer_ax_press', { app: bundle, ref: composer.ref }], ['computer_type', { text }]] as const) {
        const step = await call(tool, args);
        if (step.isError) return { ok: false, error: toText(step).slice(0, 300) };
      }
      // Pressing Send goes through the probe + confirmation card like any other act.
      const send = read.entries.find((e) => isButton(e) && e.enabled && profile.send.test(label(e).trim()));
      const submit = send ? await call('computer_ax_press', { app: bundle, ref: send.ref }) : await call('computer_key', { keys: 'Return' });
      if (submit.isError) return { ok: false, error: toText(submit).slice(0, 300) };
      return { ok: true, handle: bundle };
    },
    async status(handle) {
      const read = await tree(handle);
      return read.ok ? classifyAx(read.entries, profile) : { state: 'unknown', signals: [] };
    },
    async collect(handle) {
      const read = await tree(handle);
      if (!read.ok) return read;
      const body = scrubSecrets(chatText(read.entries));
      if (!body) return { ok: false, error: `${name}: nothing readable in the conversation.` };
      // Keep the tail: the newest answer is at the bottom.
      const truncated = body.length > MAX_COLLECT_CHARS;
      return { ok: true, text: truncated ? body.slice(-MAX_COLLECT_CHARS) : body, truncated, untrusted: true };
    },
  };
}

/** The Devin, Claude and Codex desktop adapters for one chat. */
export function createDesktopAdapters(call: ToolCall, opts: Partial<Record<DesktopAppId, DesktopAppAdapterOptions>> = {}): Record<DesktopAppId, DesktopAdapter> {
  return {
    claude: createDesktopAppAdapter(DESKTOP_APP_PROFILES.claude, call, opts.claude),
    codex: createDesktopAppAdapter(DESKTOP_APP_PROFILES.codex, call, opts.codex),
    devin: createDesktopAppAdapter(DESKTOP_APP_PROFILES.devin, call, opts.devin),
  };
}

// ---------------------------------------------------------------------------
// App control (RQ-MACCU-APPS-1): list / status / open / focus / quit
// ---------------------------------------------------------------------------
//
// Same rules as the task adapters: every step is a `computer_*` call, so the
// grant, tier ceiling, probe + confirmation card, denylist, takeover and KILL
// all stay in force. Nothing here types, sends keys, reads window text (control
// labels and window titles only) or touches TCC grants or the MACCU helper.
// There is no `computer_*` tool that launches or activates an app, so open and
// focus go through an injected `AppLauncher`; without one they refuse.

export type AppControlAction = 'open' | 'quit' | 'focus' | 'status';
export type AppControlCode = 'not-running' | 'unsupported' | 'denied' | 'unsaved-state' | 'unreadable' | 'failed';

export interface RunningApp {
  name: string;
  bundleId: string | null;
  frontmost: boolean;
}

export type AppControlResult =
  | { ok: true; action: AppControlAction; running: boolean; frontmost: boolean; detail: string }
  | { ok: false; action: AppControlAction; code: AppControlCode; error: string };

/** The only way to start or raise an app. Not a `computer_*` tool, so a host must supply it. */
export interface AppLauncher {
  open(bundleId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  activate(bundleId: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface AppControl {
  list(): Promise<{ ok: true; apps: RunningApp[] } | { ok: false; error: string }>;
  status(target: string): Promise<AppControlResult>;
  open(target: string): Promise<AppControlResult>;
  focus(target: string): Promise<AppControlResult>;
  quit(target: string): Promise<AppControlResult>;
}

export interface AppControlOptions {
  launcher?: AppLauncher;
  maxDepth?: number;
}

/** Parse `computer_list_apps` lines: `- Name (bundle.id): ...[; this chat holds X] [frontmost]`. */
export function parseRunningApps(text: string): RunningApp[] {
  const apps: RunningApp[] = [];
  for (const line of text.split('\n')) {
    const m = /^- (.+?) \(([^)]*)\): (.*)$/.exec(line);
    if (!m) continue;
    apps.push({ name: m[1]!, bundleId: m[2] && m[2] !== 'no bundle id' ? m[2] : null, frontmost: m[3]!.includes('[frontmost]') });
  }
  return apps;
}

const SAVE_CONTROL = /^(save( all)?|don.?t save|review changes|discard( changes)?)$/i;
const EDITED_TITLE = /\b(edited|unsaved|modified)\b|^\s*[*\u2022\u25cf]|[*\u2022\u25cf]\s*$/i;

/**
 * Whether the app shows signs of unsaved state. Labels and window titles only,
 * never field values. Over-reports on purpose: a false positive routes the quit
 * to needs-you, a false negative could lose someone's work.
 */
export function detectUnsavedState(entries: readonly AxEntry[]): string[] {
  const signals: string[] = [];
  if (entries.some((e) => e.role === 'AXButton' && e.enabled && SAVE_CONTROL.test(label(e).trim()))) signals.push('save-control');
  if (entries.some((e) => e.role === 'AXWindow' && (EDITED_TITLE.test(e.title) || EDITED_TITLE.test(e.description)))) signals.push('edited-window');
  if (entries.some((e) => e.role === 'AXSheet')) signals.push('open-sheet');
  return signals;
}

export function createAppControl(call: ToolCall, opts: AppControlOptions = {}): AppControl {
  const maxDepth = opts.maxDepth ?? 6;
  const fail = (action: AppControlAction, code: AppControlCode, error: string): AppControlResult => ({ ok: false, action, code, error });

  async function list(): Promise<{ ok: true; apps: RunningApp[] } | { ok: false; error: string }> {
    const res = await call('computer_list_apps', {});
    if (res.isError) return { ok: false, error: toText(res).slice(0, 300) };
    return { ok: true, apps: parseRunningApps(toText(res)) };
  }

  /** Bundle id, then exact name (case-insensitive). */
  async function find(target: string): Promise<{ ok: true; app: RunningApp | null } | { ok: false; error: string }> {
    const listed = await list();
    if (!listed.ok) return listed;
    const needle = target.trim().toLowerCase();
    const app = listed.apps.find((a) => a.bundleId?.toLowerCase() === needle) ?? listed.apps.find((a) => a.name.toLowerCase() === needle) ?? null;
    return { ok: true, app };
  }

  const bundleOf = (target: string, app: RunningApp | null): string | null =>
    app?.bundleId ?? (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(target.trim()) ? target.trim() : null);

  return {
    list,
    async status(target) {
      const found = await find(target);
      if (!found.ok) return fail('status', 'failed', found.error);
      const app = found.app;
      return { ok: true, action: 'status', running: app !== null, frontmost: app?.frontmost ?? false, detail: app ? `${app.name} is running${app.frontmost ? ' (frontmost)' : ''}.` : 'not running.' };
    },
    async open(target) {
      const found = await find(target);
      if (!found.ok) return fail('open', 'failed', found.error);
      const bundle = bundleOf(target, found.app);
      if (found.app && !bundle) return fail('open', 'denied', 'that app is never available to agents.');
      if (bundle && computerAppPolicy(bundle).ceiling === null) return fail('open', 'denied', 'that app is never available to agents.');
      if (found.app) return { ok: true, action: 'open', running: true, frontmost: found.app.frontmost, detail: `${found.app.name} is already running.` };
      if (!bundle) return fail('open', 'unsupported', 'open needs the app\'s bundle id when it is not running.');
      if (!opts.launcher) return fail('open', 'unsupported', 'no launcher is connected: the computer_* tools cannot start an app.');
      const started = await opts.launcher.open(bundle);
      return started.ok ? { ok: true, action: 'open', running: true, frontmost: false, detail: `asked macOS to open ${bundle}.` } : fail('open', 'failed', started.error.slice(0, 300));
    },
    async focus(target) {
      const found = await find(target);
      if (!found.ok) return fail('focus', 'failed', found.error);
      if (!found.app) return fail('focus', 'not-running', `${target.trim().slice(0, 80)} is not running.`);
      const bundle = bundleOf(target, found.app);
      if (!bundle || computerAppPolicy(bundle).ceiling === null) return fail('focus', 'denied', 'that app is never available to agents.');
      if (found.app.frontmost) return { ok: true, action: 'focus', running: true, frontmost: true, detail: `${found.app.name} is already frontmost.` };
      if (!opts.launcher) return fail('focus', 'unsupported', 'no launcher is connected: the computer_* tools cannot raise an app.');
      const raised = await opts.launcher.activate(bundle);
      return raised.ok ? { ok: true, action: 'focus', running: true, frontmost: true, detail: `raised ${found.app.name}.` } : fail('focus', 'failed', raised.error.slice(0, 300));
    },
    async quit(target) {
      const found = await find(target);
      if (!found.ok) return fail('quit', 'failed', found.error);
      if (!found.app) return { ok: true, action: 'quit', running: false, frontmost: false, detail: 'not running; nothing to quit.' };
      const bundle = found.app.bundleId;
      if (!bundle || computerAppPolicy(bundle).ceiling === null) return fail('quit', 'denied', 'that app is never available to agents.');
      const read = await readTreeWithAccess(call, bundle, maxDepth, `Quit the ${found.app.name} app`);
      // Unreadable means unsaved state cannot be ruled out, so it is treated as unsaved.
      if (!read.ok) return fail('quit', 'unreadable', `cannot confirm ${found.app.name} has nothing unsaved: ${read.error}`);
      const unsaved = detectUnsavedState(read.entries);
      if (unsaved.length > 0) return fail('quit', 'unsaved-state', `${found.app.name} may have unsaved work (${unsaved.join(', ')}).`);
      const quitItem = read.entries.find((e) => e.role === 'AXMenuItem' && e.enabled && /^quit\b/i.test(label(e).trim()));
      if (!quitItem) return fail('quit', 'failed', `${found.app.name}: no Quit menu item in its accessibility tree.`);
      const pressed = await call('computer_ax_press', { app: bundle, ref: quitItem.ref });
      if (pressed.isError) return fail('quit', 'failed', toText(pressed).slice(0, 300));
      return { ok: true, action: 'quit', running: false, frontmost: false, detail: `pressed Quit in ${found.app.name}.` };
    },
  };
}

// ---------------------------------------------------------------------------
// Phantom self-drive (loopback Verse API; never the screen)
// ---------------------------------------------------------------------------

/** One authenticated loopback request; the caller owns base URL, session and mutation token. */
export type VerseRequest = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; json: unknown }>;

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function createPhantomSelfDrive(request: VerseRequest, create: Record<string, unknown> = {}): DesktopAdapter {
  const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;
  const detail = async (handle: string): Promise<Record<string, unknown> | null> => {
    if (!SESSION_ID.test(handle)) return null;
    const res = await request('GET', `/api/verse/sessions/${handle}`);
    return res.status === 200 ? rec(res.json) : null;
  };
  return {
    id: 'phantom',
    async start(task) {
      const text = task.trim();
      if (!text || text.length > MAX_TASK_CHARS) return { ok: false, error: `task must be 1-${MAX_TASK_CHARS} characters.` };
      const made = await request('POST', '/api/verse/sessions', create);
      const id = rec(made.json)['id'];
      if (made.status >= 300 || typeof id !== 'string' || !SESSION_ID.test(id)) return { ok: false, error: `could not create a Phantom session (HTTP ${made.status}).` };
      const turn = await request('POST', `/api/verse/sessions/${id}/turns`, { text });
      return turn.status === 202 ? { ok: true, handle: id } : { ok: false, error: `Phantom refused the turn (HTTP ${turn.status}).` };
    },
    async status(handle) {
      const d = await detail(handle);
      const s = rec(d?.['session'])['status'];
      if (s === 'running') return { state: 'working', signals: ['session-running'] };
      if (s === 'idle') return { state: 'idle', signals: ['session-idle'] };
      return { state: 'unknown', signals: s === 'error' ? ['session-error'] : [] };
    },
    async collect(handle) {
      const d = await detail(handle);
      if (!d) return { ok: false, error: 'session not found.' };
      const events = Array.isArray(d['events']) ? d['events'].map(rec) : [];
      const done = [...events].reverse().find((e) => e['type'] === 'turn-done');
      if (!done) return { ok: false, error: 'the turn has not finished.' };
      if (done['ok'] !== true) return { ok: false, error: 'the turn failed.' };
      const answer = [...events].reverse().find((e) => e['type'] === 'assistant-message');
      const body = scrubSecrets(typeof answer?.['text'] === 'string' ? answer['text'] : '');
      return body ? { ok: true, text: body.slice(0, MAX_COLLECT_CHARS), truncated: body.length > MAX_COLLECT_CHARS, untrusted: false } : { ok: false, error: 'no answer text.' };
    },
  };
}

// ---------------------------------------------------------------------------
// Smoke driver
// ---------------------------------------------------------------------------

export interface DesktopSmokeOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type DesktopSmokeReport = { ok: true; text: string; polls: number } | { ok: false; stage: 'start' | 'status' | 'collect'; error: string };

/**
 * start → poll status until the task leaves `working` → collect. `needs-input`
 * fails fast: an approval is the operator's to give, never the smoke test's.
 */
export async function runDesktopSmoke(adapter: DesktopAdapter, task: string, opts: DesktopSmokeOptions = {}): Promise<DesktopSmokeReport> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.timeoutMs ?? 120_000);
  const started = await adapter.start(task);
  if (!started.ok) return { ok: false, stage: 'start', error: started.error };
  let polls = 0;
  // A task may not show `working` on the first read (the UI is still updating), so require one settled read after a working one, or a first idle past one poll.
  let sawWorking = false;
  for (;;) {
    await sleep(opts.pollMs ?? 2000);
    polls += 1;
    const status = await adapter.status(started.handle);
    if (status.state === 'needs-input') return { ok: false, stage: 'status', error: 'the app is waiting for an approval only the operator can give.' };
    if (status.state === 'working') sawWorking = true;
    else if (status.state === 'idle' && (sawWorking || polls >= 2)) break;
    if (now() >= deadline) return { ok: false, stage: 'status', error: 'timed out waiting for the task to finish.' };
  }
  const result = await adapter.collect(started.handle);
  return result.ok ? { ok: true, text: result.text, polls } : { ok: false, stage: 'collect', error: result.error };
}
