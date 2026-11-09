/**
 * Desktop operator. Reads are free. focus, scroll, type and click post a
 * bus intent through appendBusInbox, then act. KILL and comms pause stop
 * those writes. Screen text stays out of the bus body.
 */
import { randomUUID } from 'node:crypto';
import { appendBusInbox } from '../fleet/bus-inbox.js';
import { validateBusEnvelope, type BusEnvelope } from '../fleet/bus-envelope.js';
import { isPaused } from '../comms/pause.js';
import { killSwitchOn } from '../sandbox/policy.js';
import { scrubSecrets } from '../util/scrub.js';
import {
  ACCESSIBILITY_PERMISSION,
  DESKTOP_OPERATOR_BINARY,
  DESKTOP_OPERATOR_BUILD,
  MAX_SCROLL,
  MAX_TASK_CHARS,
  SCREEN_RECORDING_PERMISSION,
  busField,
  clampText,
  forbiddenStoreText,
  isWriteVerb,
  operatorDenyReason,
  type OperatorVerb,
  type PermissionPane,
} from './operator-policy.js';
import { createDarwinSurface, resolveDesktopOperatorBinary } from './operator-surface.js';

export type { OperatorVerb } from './operator-policy.js';

export interface RunningDesktopApp {
  name: string;
  bundleId: string | null;
  pid: number;
  executablePath?: string | null;
}

export interface DesktopWindow {
  app: string;
  bundleId: string | null;
  title: string;
  windowId: number;
  focused: boolean;
  pid: number;
}

export interface AxRead {
  source: 'ax' | 'ocr';
  text: string;
  truncated: boolean;
  nodes: number;
}

export interface ScreenshotImage {
  mime: 'image/png';
  base64: string;
  width: number;
  height: number;
  ocrText: string;
}

export type SurfaceOk<T> = { ok: true; value: T };
export type SurfaceErr = {
  ok: false;
  code: 'permission_required' | 'secure_field' | 'failed' | 'not_running' | 'denied' | 'forbidden_store';
  permission?: 'accessibility' | 'screen_recording';
  error?: string;
};
export type SurfaceResult<T> = SurfaceOk<T> | SurfaceErr;

export interface DesktopSurface {
  permissions(): Promise<{ accessibility: boolean; screenRecording: boolean; failed?: string }>;
  listApps(): Promise<SurfaceResult<RunningDesktopApp[]>>;
  windows(app?: string): Promise<SurfaceResult<DesktopWindow[]>>;
  focus(input: { app: string; window?: string }): Promise<SurfaceResult<{ focused: true }>>;
  read(input: { app: string; window?: string }): Promise<SurfaceResult<AxRead>>;
  scroll(input: { app: string; window?: string; dx: number; dy: number }): Promise<SurfaceResult<{ scrolled: true }>>;
  type(input: { app: string; window?: string; text: string }): Promise<SurfaceResult<{ typed: number }>>;
  click(input: { app: string; window?: string; x?: number; y?: number; ref?: string }): Promise<SurfaceResult<{ clicked: true }>>;
  screenshot(input: { app: string; window?: string }): Promise<SurfaceResult<ScreenshotImage>>;
}

export type OperatorRequest =
  | { verb: 'list-apps' }
  | { verb: 'windows'; app?: string }
  | { verb: 'doctor' }
  | { verb: 'focus'; app: string; window?: string }
  | { verb: 'read'; app: string; window?: string }
  | { verb: 'scroll'; app: string; window?: string; dx: number; dy: number }
  | { verb: 'type'; app: string; window?: string; text: string }
  | { verb: 'click'; app: string; window?: string; x?: number; y?: number; ref?: string }
  | { verb: 'screenshot'; app: string; window?: string };

export type OperatorErrorCode =
  | 'permission_required'
  | 'unsupported'
  | 'killed'
  | 'comms_paused'
  | 'denied'
  | 'forbidden_store'
  | 'intent_not_posted'
  | 'invalid'
  | 'helper_missing'
  | 'not_running'
  | 'secure_field'
  | 'failed';

export interface OperatorSuccess {
  ok: true;
  verb: OperatorVerb;
  data: Record<string, unknown>;
}

export interface OperatorFailure {
  ok: false;
  verb: OperatorVerb;
  code: OperatorErrorCode;
  error: string;
  permission?: 'accessibility' | 'screen_recording';
  pane?: string;
  legacyPane?: string;
  settingsUrl?: string;
  binary?: string;
  details?: Record<string, unknown>;
}

export type OperatorResult = OperatorSuccess | OperatorFailure;

export interface OperatorDeps {
  platform?: NodeJS.Platform;
  surface?: DesktopSurface;
  killed?: () => boolean;
  commsPaused?: () => boolean;
  postIntent?: (envelope: BusEnvelope) => { status: string };
  id?: () => string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  exists?: (path: string) => boolean;
  helperPath?: string | null;
}

const TEXT_KEYS = new Set(['error', 'text', 'title', 'windowTitle', 'sessionTitle', 'ocrText', 'app', 'name', 'value', 'detail']);
const INTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCREENSHOT_CAP = 1_500_000;

function fail(verb: OperatorVerb, code: OperatorErrorCode, error: string, extra: Partial<OperatorFailure> = {}): OperatorFailure {
  return { ok: false, verb, code, error: scrubSecrets(error).slice(0, 300), ...extra };
}

function permissionFailure(verb: OperatorVerb, pane: PermissionPane): OperatorFailure {
  return fail(verb, 'permission_required', `Grant ${pane.pane} to the ${pane.binary} binary.`, {
    permission: pane.permission,
    pane: pane.pane,
    ...(pane.legacyPane ? { legacyPane: pane.legacyPane } : {}),
    settingsUrl: pane.settingsUrl,
    binary: pane.binary,
  });
}

function unreachable(value: never): never {
  throw new Error(`Unhandled desktop operator request: ${JSON.stringify(value)}`);
}

export function scrubOperatorJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => scrubOperatorJson(entry));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = TEXT_KEYS.has(key) && typeof child === 'string' ? scrubSecrets(child) : scrubOperatorJson(child);
  }
  return out;
}

function needsAccessibility(verb: OperatorVerb): boolean {
  return verb !== 'doctor';
}

function needsScreenRecording(verb: OperatorVerb): boolean {
  return verb === 'screenshot' || verb === 'doctor';
}

function requestApp(request: OperatorRequest): string | undefined {
  switch (request.verb) {
    case 'list-apps':
    case 'doctor':
      return undefined;
    case 'windows':
      return request.app;
    case 'focus':
    case 'read':
    case 'scroll':
    case 'type':
    case 'click':
    case 'screenshot':
      return request.app;
    default:
      return unreachable(request);
  }
}

function requestWindow(request: OperatorRequest): string | undefined {
  switch (request.verb) {
    case 'list-apps':
    case 'doctor':
    case 'windows':
      return undefined;
    case 'focus':
    case 'read':
    case 'scroll':
    case 'type':
    case 'click':
    case 'screenshot':
      return request.window;
    default:
      return unreachable(request);
  }
}

function invalidRequest(request: OperatorRequest): string | null {
  const app = requestApp(request);
  if (app !== undefined && (app.trim().length === 0 || app.length > 200)) return 'app must be a short name or bundle id';
  const windowTitle = requestWindow(request);
  if (windowTitle !== undefined && windowTitle.length > 300) return 'window title is too long';
  if (forbiddenStoreText(app) || forbiddenStoreText(windowTitle)) return 'forbidden_store';
  switch (request.verb) {
    case 'list-apps':
    case 'windows':
    case 'doctor':
    case 'focus':
    case 'read':
    case 'screenshot':
      return null;
    case 'scroll':
      if (!Number.isInteger(request.dx) || !Number.isInteger(request.dy)) return 'dx and dy must be integers';
      if (Math.abs(request.dx) > MAX_SCROLL || Math.abs(request.dy) > MAX_SCROLL) return `scroll is limited to ${MAX_SCROLL} lines`;
      return null;
    case 'type':
      if (request.text.length === 0 || request.text.length > MAX_TASK_CHARS) return `text must be 1 to ${MAX_TASK_CHARS} characters`;
      return null;
    case 'click': {
      const hasRef = typeof request.ref === 'string' && request.ref.length > 0;
      const hasPoint = request.x !== undefined || request.y !== undefined;
      if (hasRef && !/^e\d{1,5}$/.test(request.ref ?? '')) return 'ref must look like e12';
      if (!hasRef && (request.x === undefined || request.y === undefined)) return 'click needs --ref or both --x and --y';
      if (hasPoint && (!Number.isFinite(request.x) || !Number.isFinite(request.y))) return 'x and y must be finite numbers';
      return null;
    }
    default:
      return unreachable(request);
  }
}

function doctorDetails(input: {
  platform: string;
  helperPath: string | null;
  accessibility: boolean;
  screenRecording: boolean;
  kill: boolean;
  commsPaused: boolean;
  ready: boolean;
}): Record<string, unknown> {
  return {
    ready: input.ready,
    platform: input.platform,
    binary: DESKTOP_OPERATOR_BINARY,
    helperPath: input.helperPath,
    kill: input.kill,
    commsPaused: input.commsPaused,
    accessibility: { ...ACCESSIBILITY_PERMISSION, granted: input.accessibility },
    screenRecording: { ...SCREEN_RECORDING_PERMISSION, granted: input.screenRecording },
    build: DESKTOP_OPERATOR_BUILD,
  };
}

async function resolveSurface(deps: OperatorDeps, status: { kill: boolean; commsPaused: boolean }): Promise<{ surface: DesktopSurface; helperPath: string | null } | OperatorFailure> {
  if (deps.surface) return { surface: deps.surface, helperPath: deps.helperPath ?? null };
  const platform = deps.platform ?? process.platform;
  const details = (helperPath: string | null) => doctorDetails({
    platform, helperPath, accessibility: false, screenRecording: false,
    kill: status.kill, commsPaused: status.commsPaused, ready: false,
  });
  if (platform !== 'darwin') {
    return fail('doctor', 'unsupported', 'Desktop operator runs on macOS.', {
      binary: DESKTOP_OPERATOR_BINARY,
      details: details(null),
    });
  }
  const helperPath = deps.helperPath ?? resolveDesktopOperatorBinary(deps.env ?? process.env, deps.cwd ?? process.cwd(), deps.exists);
  if (!helperPath) {
    return fail('doctor', 'helper_missing', 'The desktop-operator binary is not installed. Build it, then grant Accessibility and Screen Recording to that binary.', {
      binary: DESKTOP_OPERATOR_BINARY,
      details: details(null),
    });
  }
  return { surface: createDarwinSurface(helperPath), helperPath };
}

function matchApp(apps: readonly RunningDesktopApp[], query: string): RunningDesktopApp | undefined {
  const needle = query.trim().toLowerCase();
  return apps.find((app) => app.bundleId?.toLowerCase() === needle || app.name.toLowerCase() === needle);
}

function postWriteIntent(request: OperatorRequest, deps: OperatorDeps): OperatorFailure | null {
  const app = requestApp(request) ?? '';
  const envelope: BusEnvelope = {
    id: (deps.id ?? randomUUID)(),
    from: 'desktop-operator',
    to: 'leaders',
    priority: 'P2',
    ttl: INTENT_TTL_MS,
    body: {
      kind: 'desktop.intent',
      verb: request.verb,
      app: busField(app),
      window: busField(requestWindow(request)),
      chars: request.verb === 'type' ? request.text.length : null,
    },
  };
  const checked = validateBusEnvelope(envelope);
  if (!checked.ok) return fail(request.verb, 'intent_not_posted', 'The desktop intent was not a valid bus envelope.');
  let status = 'unavailable';
  try {
    status = (deps.postIntent ?? ((value) => appendBusInbox(value)))(checked.value).status;
  } catch {
    status = 'unavailable';
  }
  if (status !== 'posted' && status !== 'duplicate') {
    return fail(request.verb, 'intent_not_posted', 'The desktop intent was not posted to the agent bus, so the write did not run.');
  }
  return null;
}

/** A stop probe that throws counts as engaged: a write must never run on an unknown pause state. */
function failClosedProbe(probe: () => boolean): boolean {
  try { return probe() !== false; } catch { return true; }
}

export async function runDesktopOperator(request: OperatorRequest, deps: OperatorDeps = {}): Promise<OperatorResult> {
  const problem = invalidRequest(request);
  if (problem === 'forbidden_store') {
    return fail(request.verb, 'forbidden_store', 'Desktop operator does not read Messages, the keychain, or credential stores.');
  }
  if (problem) return fail(request.verb, 'invalid', problem);

  const kill = failClosedProbe(deps.killed ?? killSwitchOn);
  const commsPaused = failClosedProbe(deps.commsPaused ?? isPaused);
  if (isWriteVerb(request.verb) && kill) {
    return fail(request.verb, 'killed', 'The fleet KILL switch is on. Desktop writes are stopped.');
  }
  if (isWriteVerb(request.verb) && commsPaused) {
    return fail(request.verb, 'comms_paused', 'Comms pause is on. Desktop writes are paused.');
  }

  const resolved = await resolveSurface(deps, { kill, commsPaused });
  if ('code' in resolved) return { ...resolved, verb: request.verb };
  const { surface, helperPath } = resolved;
  const platform = deps.platform ?? process.platform;

  let grants: { accessibility: boolean; screenRecording: boolean; failed?: string } = { accessibility: true, screenRecording: true };
  if (needsAccessibility(request.verb) || needsScreenRecording(request.verb) || request.verb === 'doctor') {
    grants = await surface.permissions();
  }
  if (grants.failed) return fail(request.verb, 'failed', grants.failed);

  if (request.verb === 'doctor') {
    const ready = platform === 'darwin' && grants.accessibility && grants.screenRecording && (deps.surface !== undefined || helperPath !== null);
    const details = doctorDetails({ platform, helperPath, accessibility: grants.accessibility, screenRecording: grants.screenRecording, kill, commsPaused, ready });
    if (!grants.accessibility) return { ...permissionFailure('doctor', ACCESSIBILITY_PERMISSION), details };
    if (!grants.screenRecording) return { ...permissionFailure('doctor', SCREEN_RECORDING_PERMISSION), details };
    if (platform !== 'darwin' && !deps.surface) return fail('doctor', 'unsupported', 'Desktop operator runs on macOS.', { details });
    return { ok: true, verb: 'doctor', data: details };
  }

  if (needsAccessibility(request.verb) && !grants.accessibility) return permissionFailure(request.verb, ACCESSIBILITY_PERMISSION);
  if (needsScreenRecording(request.verb) && !grants.screenRecording) return permissionFailure(request.verb, SCREEN_RECORDING_PERMISSION);

  if (request.verb === 'list-apps') {
    const listed = await surface.listApps();
    if (!listed.ok) return fromSurface('list-apps', listed);
    return {
      ok: true,
      verb: 'list-apps',
      data: {
        apps: listed.value.map((app) => ({
          ...app,
          operable: operatorDenyReason({ name: app.name, bundleId: app.bundleId, executablePath: app.executablePath, verb: 'read' }) === null,
        })),
      },
    };
  }

  if (request.verb === 'windows') {
    const listed = await surface.windows(request.app);
    if (!listed.ok) return fromSurface('windows', listed);
    const windows = listed.value.filter((window) => operatorDenyReason({
      name: window.app, bundleId: window.bundleId, windowTitle: window.title, verb: 'windows',
    }) === null);
    return { ok: true, verb: 'windows', data: { windows } };
  }

  const listed = await surface.listApps();
  if (!listed.ok) return fromSurface(request.verb, listed);
  const app = matchApp(listed.value, request.app);
  if (!app) return fail(request.verb, 'not_running', 'That app is not running.');
  const denied = operatorDenyReason({
    name: app.name,
    bundleId: app.bundleId,
    executablePath: app.executablePath,
    windowTitle: requestWindow(request),
    verb: request.verb,
  });
  if (denied) return fail(request.verb, 'denied', denied);

  if (isWriteVerb(request.verb)) {
    const blocked = postWriteIntent(request, deps);
    if (blocked) return blocked;
  }

  const acted = await act(surface, request);
  if (!acted.ok) return fromSurface(request.verb, acted);
  if ('base64' in acted.value && (acted.value.base64.length === 0 || acted.value.base64.length > SCREENSHOT_CAP)) {
    return fail(request.verb, 'failed', 'screenshot exceeded the response cap');
  }
  return { ok: true, verb: request.verb, data: shape(request, acted.value) };
}

function fromSurface(verb: OperatorVerb, result: SurfaceErr): OperatorFailure {
  if (result.code === 'permission_required') {
    return permissionFailure(verb, result.permission === 'screen_recording' ? SCREEN_RECORDING_PERMISSION : ACCESSIBILITY_PERMISSION);
  }
  const code = result.code === 'secure_field' || result.code === 'not_running' || result.code === 'denied' || result.code === 'forbidden_store'
    ? result.code
    : 'failed';
  return fail(verb, code, result.error ?? code);
}

async function act(surface: DesktopSurface, request: Exclude<OperatorRequest, { verb: 'list-apps' | 'windows' | 'doctor' }>): Promise<SurfaceResult<AxRead | ScreenshotImage | { focused: true } | { scrolled: true } | { typed: number } | { clicked: true }>> {
  switch (request.verb) {
    case 'focus':
      return surface.focus({ app: request.app, ...(request.window ? { window: request.window } : {}) });
    case 'read':
      return surface.read({ app: request.app, ...(request.window ? { window: request.window } : {}) });
    case 'scroll':
      return surface.scroll({ app: request.app, dx: request.dx, dy: request.dy, ...(request.window ? { window: request.window } : {}) });
    case 'type':
      return surface.type({ app: request.app, text: request.text, ...(request.window ? { window: request.window } : {}) });
    case 'click':
      return surface.click({
        app: request.app,
        ...(request.window ? { window: request.window } : {}),
        ...(request.ref ? { ref: request.ref } : {}),
        ...(request.x !== undefined && request.y !== undefined ? { x: request.x, y: request.y } : {}),
      });
    case 'screenshot':
      return surface.screenshot({ app: request.app, ...(request.window ? { window: request.window } : {}) });
    default:
      return unreachable(request);
  }
}

function shape(request: OperatorRequest, value: AxRead | ScreenshotImage | { focused: true } | { scrolled: true } | { typed: number } | { clicked: true }): Record<string, unknown> {
  if ('text' in value && 'source' in value) {
    const clamped = clampText(value.text);
    return { app: requestApp(request), source: value.source, text: clamped.text, truncated: value.truncated || clamped.truncated, nodes: value.nodes, untrusted: true };
  }
  if ('base64' in value) {
    const ocr = clampText(value.ocrText);
    return { app: requestApp(request), mime: value.mime, base64: value.base64, width: value.width, height: value.height, ocrText: ocr.text, untrusted: true };
  }
  return { app: requestApp(request), ...value };
}
