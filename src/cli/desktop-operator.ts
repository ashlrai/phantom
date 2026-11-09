/**
 * `phm desktop` operator verbs. Install stays in desktop.ts.
 */
import type { OperatorDeps, OperatorRequest, OperatorResult } from '../core/desktop/operator.js';
import { runDesktopOperator, scrubOperatorJson } from '../core/desktop/operator.js';
import { deliverScreenshot } from '../core/desktop/operator-screenshot.js';

export const OPERATOR_USAGE = `Usage: phm desktop list-apps [--json]
       phm desktop windows [--app <name>] [--json]
       phm desktop focus --app <name> [--window <title>] [--json]
       phm desktop read --app <name> [--window <title>] [--json]
       phm desktop scroll --app <name> [--window <title>] [--dx <n>] [--dy <n>] [--json]
       phm desktop type --app <name> [--window <title>] --text <text> [--json]
       phm desktop click --app <name> [--window <title>] [--x <n> --y <n> | --ref <eN>] [--json]
       phm desktop screenshot --app <name> [--window <title>] [--json]
       phm desktop doctor [--json]

macOS desktop operator. Accessibility reads come first. A window screenshot
plus OCR is the fallback. focus, scroll, type and click post a bus intent
before they change another app. KILL and comms pause block those writes.
Screenshots are local-only: the PNG is written mode 0600 under
~/.ashlr/desktop-operator/shots/ and the result carries its path, metadata and
scrubbed OCR text, never image bytes.
Exit 0 when ok is true, 1 when ok is false, 2 for usage.
`;

const VERBS = ['list-apps', 'windows', 'focus', 'read', 'scroll', 'type', 'click', 'screenshot', 'doctor'] as const;
type Verb = (typeof VERBS)[number];

export interface DesktopOperatorCliDeps extends OperatorDeps {
  log?: (line: string) => void;
  error?: (line: string) => void;
  writeScreenshot?: (bytes: Buffer) => string;
}

function isVerb(value: string): value is Verb {
  return (VERBS as readonly string[]).includes(value);
}

function take(map: Map<string, string>, flag: string): string | undefined {
  const value = map.get(flag);
  return value === undefined ? undefined : value;
}

function integer(map: Map<string, string>, flag: string): number | undefined | 'bad' {
  const value = map.get(flag);
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value)) return 'bad';
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 'bad';
}

export function parseDesktopOperatorArgs(args: readonly string[]): { help: true } | { error: string } | { json: boolean; request: OperatorRequest } {
  if (args.length === 0 || args.some((arg) => arg === '--help' || arg === '-h' || arg === 'help')) return { help: true };
  const verb = args[0] ?? '';
  if (!isVerb(verb)) return { error: 'unknown desktop verb' };
  const map = new Map<string, string>();
  let json = false;
  for (let i = 1; i < args.length; i += 1) {
    const token = args[i] ?? '';
    if (token === '--json') {
      json = true;
      continue;
    }
    if (!token.startsWith('--')) return { error: 'unknown desktop argument' };
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: `${token} needs a value` };
    if (map.has(token)) return { error: `duplicate ${token}` };
    map.set(token, value);
    i += 1;
  }
  const known = new Set(['--app', '--window', '--text', '--x', '--y', '--dx', '--dy', '--ref']);
  for (const flag of map.keys()) if (!known.has(flag)) return { error: `unknown flag ${flag}` };
  const app = take(map, '--app');
  const window = take(map, '--window');
  const withWindow = window ? { window } : {};
  switch (verb) {
    case 'list-apps':
    case 'doctor':
      if (map.size > 0) return { error: `${verb} takes no flags besides --json` };
      return { json, request: { verb } };
    case 'windows':
      if ([...map.keys()].some((flag) => flag !== '--app')) return { error: 'windows accepts --app' };
      return { json, request: { verb, ...(app ? { app } : {}) } };
    case 'focus':
    case 'read':
    case 'screenshot':
      if (!app) return { error: '--app is required' };
      if ([...map.keys()].some((flag) => flag !== '--app' && flag !== '--window')) return { error: `${verb} accepts --app and --window` };
      return { json, request: { verb, app, ...withWindow } };
    case 'scroll': {
      if (!app) return { error: '--app is required' };
      const dx = integer(map, '--dx');
      const dy = integer(map, '--dy');
      if (dx === 'bad' || dy === 'bad') return { error: '--dx and --dy must be integers' };
      return { json, request: { verb, app, dx: dx ?? 0, dy: dy ?? -3, ...withWindow } };
    }
    case 'type': {
      if (!app) return { error: '--app is required' };
      const text = take(map, '--text');
      if (text === undefined) return { error: '--text is required' };
      return { json, request: { verb, app, text, ...withWindow } };
    }
    case 'click': {
      if (!app) return { error: '--app is required' };
      const x = integer(map, '--x');
      const y = integer(map, '--y');
      if (x === 'bad' || y === 'bad') return { error: '--x and --y must be integers' };
      const ref = take(map, '--ref');
      if (!ref && (typeof x !== 'number' || typeof y !== 'number')) return { error: 'click needs --ref or both --x and --y' };
      return {
        json,
        request: {
          verb,
          app,
          ...withWindow,
          ...(ref ? { ref } : {}),
          ...(typeof x === 'number' ? { x } : {}),
          ...(typeof y === 'number' ? { y } : {}),
        },
      };
    }
    default: {
      const unhandled: never = verb;
      return { error: `unknown desktop verb ${String(unhandled)}` };
    }
  }
}

function summary(result: OperatorResult): string {
  if (result.ok) return `desktop ${result.verb}: ok`;
  return `desktop ${result.verb}: ${result.code}`;
}

export async function cmdDesktopOperator(args: readonly string[], deps: DesktopOperatorCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const parsed = parseDesktopOperatorArgs(args);
  if ('help' in parsed) {
    log(OPERATOR_USAGE);
    return 0;
  }
  if ('error' in parsed) {
    error(parsed.error);
    error(OPERATOR_USAGE);
    return 2;
  }
  const raw = await runDesktopOperator(parsed.request, deps);
  const result = deliverScreenshot(raw, { ...(deps.writeScreenshot ? { write: deps.writeScreenshot } : {}) });
  const body = scrubOperatorJson(result);
  log(parsed.json ? JSON.stringify(body) : summary(result));
  return result.ok ? 0 : 1;
}
