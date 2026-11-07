/** App control v1. Reuses the console's read routes and mutation authority. */
import { readFile, lstat } from 'node:fs/promises';
import { parseVersePreferencesUpdate } from '../verse/preferences.js';

export const APP_ACTIONS = {
  pause: '/api/fleet/pause', resume: '/api/fleet/resume', prefs: '/api/verse/preferences',
} as const;
export type AppAction = keyof typeof APP_ACTIONS;
export const APP_CONTROL_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'phantom:app.control.v1', type: 'object', additionalProperties: false,
  required: ['version', 'action'], properties: {
    version: { const: 'app.control.v1' }, action: { enum: Object.keys(APP_ACTIONS) },
    update: { oneOf: [
      { type: 'object', additionalProperties: false, required: ['memoryEnabled'], properties: { memoryEnabled: { type: 'boolean' } } },
      { type: 'object', additionalProperties: false, required: ['projectPath', 'memoryEnabled'], properties: { projectPath: { type: 'string' }, memoryEnabled: { type: 'boolean' } } },
      { type: 'object', additionalProperties: false, required: ['seatId', 'contextMode'], properties: { seatId: { type: 'string' }, contextMode: { enum: ['standard', 'expansive'] } } },
    ] },
  },
  allOf: [{ if: { properties: { action: { const: 'prefs' } } }, then: { required: ['update'] }, else: { not: { required: ['update'] } } }],
} as const;
export interface AppRequest { version: 'app.control.v1'; action: AppAction; update?: unknown }
export function parseAppRequest(value: unknown): AppRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid app request');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['version', 'action', 'update'].includes(k)) ||
      v['version'] !== 'app.control.v1' || typeof v['action'] !== 'string' ||
      !Object.hasOwn(APP_ACTIONS, v['action'])) throw new Error('Invalid app request');
  if (v['action'] === 'prefs') parseVersePreferencesUpdate(v['update']);
  else if ('update' in v) throw new Error('Steering does not accept an update');
  return v as unknown as AppRequest;
}

export interface AppConnection { url: string; token: string; readToken?: string }
/** Explicit private credential file; never place a token on argv or follow redirects. */
export async function appConnection(file: string): Promise<AppConnection> {
  const stat = await lstat(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('App connection must be a private regular file');
  const v = JSON.parse(await readFile(file, 'utf8')) as AppConnection;
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(v.url) ||
      new URL(v.url).port === '' || !/^[a-f0-9]{64}$/.test(v.token)) throw new Error('Invalid app connection');
  if (v.readToken !== undefined && !/^[a-f0-9]{64}$/.test(v.readToken)) throw new Error('Invalid read credential');
  return v;
}
export async function appFetch(connection: AppConnection, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${connection.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { 'x-ashlr-token': body === undefined ? (connection.readToken ?? '') : connection.token, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`App request failed (${response.status})`);
  return response.json();
}
/** Only numeric readings leave the usage projection. Missing readings stay unknown. */
export function appReadings(value: unknown): unknown {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && ['standard', 'expansive', 'running', 'stopped', 'paused'].includes(value)) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 'unknown';
  if (Array.isArray(value)) return value.map(appReadings);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/token|secret|password|credential|url|path|log|reason|msg/i.test(key) || /^(totalTokens|tokens|tokensIn|tokensOut)$/.test(key))
    .map(([key, reading]) => [key, appReadings(reading)]));
  return 'unknown';
}
