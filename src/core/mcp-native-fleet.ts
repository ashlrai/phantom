/** Fleet apps tools are installed only by the MCP CLI entry point. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { registerNativeTools, type NativeToolImpl } from './mcp-native.js';
import { FLEET_APPS } from './fleet/app-await.js';

const runsDir = (): string => process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');

const tools: NativeToolImpl[] = [
  {
    name: 'phantom_fleet_apps_history',
    description: 'Read retained app recovery observations and summaries without starting a watcher.',
    inputSchema: { type: 'object', properties: {
      after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      invocationId: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' },
    }, additionalProperties: false },
    safety: 'read',
    handler: async args => (await import('./fleet/apps-recovery-history.js')).readAppsRecoveryHistory(
      runsDir(),
      (args.after as number | undefined) ?? 0, (args.limit as number | undefined) ?? 25, args.invocationId as string | undefined,
    ),
  },
  {
    name: 'phantom_fleet_apps_follow',
    description: 'Follow retained app recovery events within a bounded deadline; resume using the returned cursor.',
    inputSchema: { type: 'object', properties: {
      durationMs: { type: 'integer', minimum: 1, maximum: 30000 },
      after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      invocationId: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' },
      untilSummary: { type: 'boolean' },
      intervalMs: { type: 'integer', minimum: 100, maximum: 60000 },
      maxEvents: { type: 'integer', minimum: 1, maximum: 100 },
    }, required: ['durationMs'], additionalProperties: false },
    safety: 'read',
    handler: async args => {
      const flags = ['--root', runsDir(), '--duration-ms', String(args.durationMs), '--max-events', String(args.maxEvents ?? 100), '--jsonl'];
      for (const [key, flag] of [['after', '--after'], ['invocationId', '--invocation-id'], ['intervalMs', '--interval-ms']] as const) {
        if (args[key] !== undefined) flags.push(flag, String(args[key]));
      }
      if (args.untilSummary) flags.push('--until-summary');
      const events: unknown[] = [];
      let summary: unknown = null;
      const exitCode = await (await import('../cli/fleet-apps-follow.js')).cmdFleetAppsFollow(flags, {
        emit: line => {
          const record = JSON.parse(line) as { type: string; event?: unknown };
          if (record.type === 'event') events.push(record.event);
          else if (record.type === 'summary') summary = record;
          else throw new Error('Invalid follow record');
        },
      });
      return { events, summary, exitCode, ...(exitCode !== 0 || !summary ? { error: 'Fleet app follow failed' } : {}) };
    },
  },
  {
    name: 'phantom_fleet_apps_recovery_wait',
    description: 'Wait for retained recovery evidence for one invocation to become fresh and healthy or terminal.',
    inputSchema: { type: 'object', properties: {
      invocationId: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' },
      maxAgeMs: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 },
      intervalMs: { type: 'integer', minimum: 100, maximum: 60000 },
    }, required: ['invocationId', 'maxAgeMs', 'timeoutMs'], additionalProperties: false },
    safety: 'read',
    handler: async args => (await import('./fleet/apps-recovery-wait.js')).waitAppsRecovery({
      root: runsDir(), invocation: args.invocationId as string,
      maxAge: args.maxAgeMs as number, duration: args.timeoutMs as number, interval: (args.intervalMs as number | undefined) ?? 1000,
    }),
  },
  {
    name: 'phantom_fleet_apps_recovery_check',
    description: 'Check whether one recovery invocation retains fresh, healthy evidence in the local runs store. Reads only; never queries or launches apps. Returns stale, terminal, unhealthy, or unknown evidence outcomes without substituting healthy.',
    inputSchema: { type: 'object', properties: {
      invocationId: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' },
      maxAgeMs: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    }, required: ['invocationId', 'maxAgeMs'], additionalProperties: false },
    safety: 'read',
    handler: async args => {
      const { readAppsRecoveryInvocations } = await import('./fleet/apps-recovery-invocations.js');
      const { appsRecoveryVerdict } = await import('./fleet/apps-recovery-verdict.js');
      const projection = readAppsRecoveryInvocations(runsDir());
      return appsRecoveryVerdict(projection, args.invocationId as string, args.maxAgeMs as number, Date.now());
    },
  },
  {
    name: 'phantom_fleet_apps_recovery_batch',
    description: 'Wait for retained recovery evidence for multiple invocations. Read-only; no live probe or app control.',
    inputSchema: { type: 'object', properties: {
      invocationIds: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true,
        items: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' } },
      maxAgeMs: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      durationMs: { type: 'integer', minimum: 1, maximum: 300000 },
      intervalMs: { type: 'integer', minimum: 100, maximum: 60000 },
    }, required: ['invocationIds', 'maxAgeMs', 'durationMs'], additionalProperties: false },
    safety: 'read',
    handler: async args => {
      const { cmdFleetAppsRecoveryBatch } = await import('../cli/fleet-apps-recovery-batch.js');
      const commandArgs = ['--root', runsDir(), '--json',
        '--max-age-ms', String(args.maxAgeMs), '--duration-ms', String(args.durationMs)];
      if (args.intervalMs !== undefined) commandArgs.push('--interval-ms', String(args.intervalMs));
      for (const id of args.invocationIds as string[]) commandArgs.push('--invocation', id);
      let output = '';
      const code = await cmdFleetAppsRecoveryBatch(commandArgs, { emit: line => { output = line; } });
      const result: unknown = JSON.parse(output);
      if (!result || typeof result !== 'object' || Array.isArray(result) ||
        !('outcome' in result) || !('evidence' in result) || result.evidence !== 'retained' ||
        !('liveProbe' in result) || result.liveProbe !== false ||
        (code === 0) !== (result.outcome === 'healthy')) throw new Error('Invalid batch result');
      return result;
    },
  },
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
  {
    name: 'phantom_fleet_apps_watch',
    description: 'Supervise an explicit group of local managed apps through sequential batches under a shared deadline.',
    get inputSchema() { return { type: 'object', properties: {
      apps: { type: 'array', items: { type: 'string', enum: [...FLEET_APPS] }, minItems: 1, maxItems: 8, uniqueItems: true },
      durationMs: { type: 'integer', minimum: 1, maximum: 10000 },
      intervalMs: { type: 'integer', minimum: 100, maximum: 10000 },
      maxConsecutiveFailures: { type: 'integer', minimum: 1, maximum: 10 },
    }, required: ['apps', 'durationMs'], additionalProperties: false }; },
    safety: 'append',
    handler: async args => (await import('../cli/fleet-apps-watch.js')).watchFleetApps({
      apps: args.apps as string[],
      durationMs: args.durationMs as number,
      intervalMs: (args.intervalMs as number | undefined) ?? 1000,
      maxConsecutiveFailures: (args.maxConsecutiveFailures as number | undefined) ?? 1,
    }),
  },
];

export function registerFleetNativeTools(): void {
  registerNativeTools(tools);
}
