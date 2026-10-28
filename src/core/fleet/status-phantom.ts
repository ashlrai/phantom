/** Fleet status: phantom. Internal to status.ts. */

import type {
  AshlrConfig,
  PhantomAgentReportRollup,
} from '../types.js';
import type {
  FleetPhantomStatus,
  FleetPhantomState,
  PhantomAuditSignalSummary,
} from './status-types.js';
import {
  homedir,
} from 'node:os';

export async function buildFleetPhantomStatus(cfg: AshlrConfig): Promise<FleetPhantomStatus | undefined> {
  const observedAt = new Date().toISOString();
  try {
    const { getCachedFleetPhantomStatus } = await import('../phantom.js');
    const includeAgentReport = cfg.phantom?.agentReportRollup?.enabled === true;
    const status = getCachedFleetPhantomStatus({
      includeAgentReport,
      ...(cfg.phantom?.agentReportRollup?.timeoutMs ? { timeoutMs: cfg.phantom.agentReportRollup.timeoutMs } : {}),
      ...(cfg.phantom?.agentReportRollup?.cacheTtlMs ? { ttlMs: cfg.phantom.agentReportRollup.cacheTtlMs } : {}),
    });
    const known = status.capability.knownFleetSecrets;
    const state: FleetPhantomState = status.error
      ? 'degraded'
      : !status.installed
        ? 'not-installed'
        : !status.initialized
          ? 'not-initialized'
          : 'ready';
    const agentReport = status.capability.commands.agentAvailable && status.agentReport
      ? sanitizeFleetPhantomAgentReport(status.agentReport)
      : undefined;
    return {
      observedAt,
      state,
      installed: status.installed,
      initialized: status.initialized,
      version: status.version,
      valueMode: status.capability.valueMode,
      secretCount: status.capability.secretCount,
      knownFleetSecrets: {
        total: known.names.length,
        presentCount: known.present.length,
        missingCount: known.missing.length,
        pulseCredentialPresent: known.pulseCredentialPresent,
        nimApiKeyPresent: known.present.includes('NVIDIA_NIM_API_KEY'),
      },
      capabilities: status.capability.modes,
      commands: status.capability.commands,
      config: {
        phantomExecEnabled: cfg.phantom?.enabled === true,
        fleetSecretInjectionEnabled: cfg.foundry?.usePhantom === true,
      },
      mcp: {
        configured: await phantomMcpConfigured(),
      },
      ...(agentReport ? { agentReport } : {}),
      ...(status.error ? { error: sanitizeFleetPhantomError(status.error) } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      observedAt,
      state: 'degraded',
      installed: false,
      initialized: false,
      version: null,
      valueMode: 'metadata-and-names-only',
      secretCount: 0,
      knownFleetSecrets: {
        total: 0,
        presentCount: 0,
        missingCount: 0,
        pulseCredentialPresent: false,
        nimApiKeyPresent: false,
      },
      capabilities: {
        metadataStatus: false,
        childEnvInjectionAvailable: false,
        mcpServerAvailable: false,
        mutationRequiresHumanApproval: false,
      },
      commands: {
        commandsKnown: false,
        setupAvailable: false,
        execAvailable: false,
        mcpAvailable: false,
        agentAvailable: false,
      },
      config: {
        phantomExecEnabled: cfg.phantom?.enabled === true,
        fleetSecretInjectionEnabled: cfg.foundry?.usePhantom === true,
      },
      mcp: { configured: false },
      error: sanitizeFleetPhantomError(message),
    };
  }
}

const PHANTOM_AGENT_STATUS_COUNT_KEYS = new Set([
  'ok',
  'warning',
  'review',
  'requires-approval',
  'failed',
  'blocked',
  'skipped',
  'unknown',
  'other',
]);

const PHANTOM_AGENT_RISK_COUNT_KEYS = new Set(['none', 'low', 'medium', 'high', 'critical', 'unknown', 'other']);

const PHANTOM_AGENT_SEVERITY_COUNT_KEYS = new Set(['info', 'low', 'medium', 'high', 'critical', 'unknown', 'other']);

const PHANTOM_AGENT_DELEGATION_STATUS_COUNT_KEYS = new Set([
  'ok',
  'warning',
  'review',
  'requires-approval',
  'failed',
  'blocked',
  'skipped',
  'unknown',
  'other',
]);

const PHANTOM_AGENT_DELEGATION_ACTION_COUNT_KEYS = new Set([
  'delegate',
  'review',
  'approve',
  'block',
  'initialize',
  'configure',
  'none',
  'unknown',
  'other',
]);

function sanitizeFleetPhantomAgentReport(report: PhantomAgentReportRollup): PhantomAgentReportRollup {
  const delegationSafety = sanitizeFleetPhantomDelegationSafety(report.delegationSafety);
  return {
    valuesHidden: true,
    scannedRepos: safeFleetPhantomCount(report.scannedRepos),
    validReports: safeFleetPhantomCount(report.validReports),
    failedReports: safeFleetPhantomCount(report.failedReports),
    statusCounts: safeFleetPhantomCountMap(report.statusCounts, PHANTOM_AGENT_STATUS_COUNT_KEYS),
    riskCounts: safeFleetPhantomCountMap(report.riskCounts, PHANTOM_AGENT_RISK_COUNT_KEYS),
    severityCounts: safeFleetPhantomCountMap(report.severityCounts, PHANTOM_AGENT_SEVERITY_COUNT_KEYS),
    requiresApprovalCount: safeFleetPhantomCount(report.requiresApprovalCount),
    ...(delegationSafety ? { delegationSafety } : {}),
  };
}

function sanitizeFleetPhantomDelegationSafety(
  input: PhantomAgentReportRollup['delegationSafety'],
): PhantomAgentReportRollup['delegationSafety'] | undefined {
  if (!input) return undefined;
  const rawSafetyCounts = input.safetyCounts ?? { safe: 0, unsafe: 0, unknown: 0 };
  const safetyCounts = {
    safe: safeFleetPhantomCount(rawSafetyCounts.safe),
    unsafe: safeFleetPhantomCount(rawSafetyCounts.unsafe),
    unknown: safeFleetPhantomCount(rawSafetyCounts.unknown),
  };
  const statusCounts = safeFleetPhantomCountMap(
    input.statusCounts,
    PHANTOM_AGENT_DELEGATION_STATUS_COUNT_KEYS,
  );
  const primaryActionCounts = safeFleetPhantomCountMap(
    input.primaryActionCounts,
    PHANTOM_AGENT_DELEGATION_ACTION_COUNT_KEYS,
  );
  const hasSafety = safetyCounts.safe > 0 || safetyCounts.unsafe > 0 || safetyCounts.unknown > 0;
  if (!hasSafety && Object.keys(statusCounts).length === 0 && Object.keys(primaryActionCounts).length === 0) {
    return undefined;
  }
  return { safetyCounts, statusCounts, primaryActionCounts };
}

function safeFleetPhantomCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(Math.min(value, Number.MAX_SAFE_INTEGER));
}

function safeFleetPhantomCountMap(
  counts: Record<string, number> | undefined,
  allowedKeys: Set<string>,
): Record<string, number> {
  const safe: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts ?? {})) {
    if (!allowedKeys.has(key)) continue;
    const count = safeFleetPhantomCount(value);
    if (count > 0) safe[key] = count;
  }
  return safe;
}

async function phantomMcpConfigured(): Promise<boolean> {
  try {
    const { discoverMcpServers } = await import('../mcp-registry.js');
    const registry = discoverMcpServers();
    return registry.servers.some((candidate) =>
      candidate.name === 'phantom-secrets' ||
      (candidate.command === 'phantom' && candidate.args[0] === 'mcp')
    );
  } catch {
    return false;
  }
}

function sanitizeFleetPhantomError(error: string): string {
  const home = homedir();
  const clean = error
    .replaceAll(home, '~')
    .replace(/\/Users\/[^/\s]+/g, '~')
    .replace(/\/home\/[^/\s]+/g, '~')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 180 ? `${clean.slice(0, 177)}...` : clean;
}

export function phantomAuditSignalSummary(report: PhantomAgentReportRollup | undefined): PhantomAuditSignalSummary | null {
  if (!report) return null;

  const approvalReports = Math.max(report.requiresApprovalCount, report.statusCounts['requires-approval'] ?? 0);
  const failedReports = Math.max(report.failedReports, report.statusCounts.failed ?? 0);
  const highRiskSignals = (report.riskCounts.high ?? 0) + (report.riskCounts.critical ?? 0);
  const highSeveritySignals = (report.severityCounts.high ?? 0) + (report.severityCounts.critical ?? 0);
  const delegation = report.delegationSafety;
  const unsafeDelegations = delegation?.safetyCounts.unsafe ?? 0;
  const blockedDelegations =
    (delegation?.statusCounts.blocked ?? 0) +
    (delegation?.statusCounts.failed ?? 0);
  const reviewDelegations =
    (delegation?.statusCounts.review ?? 0) +
    (delegation?.statusCounts['requires-approval'] ?? 0) +
    (delegation?.primaryActionCounts.review ?? 0) +
    (delegation?.primaryActionCounts.approve ?? 0) +
    (delegation?.primaryActionCounts.block ?? 0);

  const signals = [
    countSignal(approvalReports, 'approval-required report'),
    countSignal(failedReports, 'failed report'),
    countSignal(highRiskSignals, 'high/critical risk signal'),
    countSignal(highSeveritySignals, 'high/critical severity signal'),
    countSignal(unsafeDelegations, 'unsafe delegation'),
    countSignal(blockedDelegations, 'blocked delegation'),
    countSignal(reviewDelegations, 'delegation review signal'),
  ].filter((signal): signal is string => signal !== null);

  if (signals.length === 0) return null;

  const scope = report.scannedRepos > 0 ? ` across ${countPhrase(report.scannedRepos, 'scanned repo')}` : '';
  return {
    signals,
    detail: `Phantom audit rollup needs review${scope}: ${signals.join(', ')}. Values hidden; only aggregate counts are shown.`,
  };
}

function countSignal(count: number, singular: string): string | null {
  return count > 0 ? countPhrase(count, singular) : null;
}

export function countPhrase(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}
