/** Fleet apps tools are installed only by the MCP CLI entry point. */
import { registerNativeTools, type NativeToolImpl } from './mcp-native.js';
import { FLEET_APPS } from './fleet/app-await.js';

const tools: NativeToolImpl[] = [
  {
    name: 'phantom_fleet_apps_ensure',
    description: 'Ensure an explicit group of local managed apps is running under one shared deadline.',
    get inputSchema() { return { type: 'object', properties: {
      apps: { type: 'array', items: { type: 'string', enum: [...FLEET_APPS] }, minItems: 1, maxItems: 8, uniqueItems: true },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 },
    }, required: ['apps'], additionalProperties: false }; },
    safety: 'append',
    handler: async args => (await import('../cli/fleet-apps-ensure.js')).ensureFleetApps({
      apps: args.apps as string[], timeoutMs: (args.timeoutMs as number | undefined) ?? 30000,
    }),
  },
  {
    name: 'phantom_fleet_apps_changes',
    description: 'Observe selected local managed app state changes within a bounded deadline.',
    get inputSchema() { return { type: 'object', properties: {
      durationMs: { type: 'integer', minimum: 1, maximum: 10000 },
      intervalMs: { type: 'integer', minimum: 100, maximum: 10000 },
      apps: { type: 'array', items: { type: 'string', enum: [...FLEET_APPS] }, minItems: 1, maxItems: 8, uniqueItems: true },
    }, required: ['durationMs'], additionalProperties: false }; },
    safety: 'read',
    handler: async args => (await import('../cli/fleet-apps-changes.js')).observeFleetAppsChanges({
      durationMs: args.durationMs as number, intervalMs: args.intervalMs as number | undefined,
      apps: args.apps as string[] | undefined, maxEvents: 256,
    }),
  },
  {
    name: 'phantom_fleet_apps_status',
    description: 'Read the bounded local inventory of managed desktop app running states; unavailable and unknown states are reported explicitly.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    safety: 'read',
    handler: async () => (await import('../cli/fleet-apps-status.js')).readFleetAppsStatus(),
  },
  {
    name: 'phantom_fleet_apps_await',
    description: 'Wait for an explicit group of managed apps to reach a stated state (running or stopped) under a shared wall deadline. Read-only; never launch, quit, or restart.',
    get inputSchema() { return { type: 'object', properties: {
      apps: { type: 'array', items: { type: 'string', enum: [...FLEET_APPS] }, minItems: 1, maxItems: 8, uniqueItems: true },
      target: { type: 'string', enum: ['running', 'stopped'] },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 },
      intervalMs: { type: 'integer', minimum: 100, maximum: 60000 },
    }, required: ['apps'], additionalProperties: false }; },
    safety: 'read',
    handler: async args => (await import('../cli/fleet-apps-await.js')).awaitFleetApps({
      apps: args.apps as string[],
      target: (args.target as 'running' | 'stopped') ?? 'running',
      timeoutMs: (args.timeoutMs as number | undefined) ?? 30000,
      intervalMs: (args.intervalMs as number | undefined) ?? 1000,
    }),
  },
];

export function registerFleetNativeTools(): void {
  registerNativeTools(tools);
}
