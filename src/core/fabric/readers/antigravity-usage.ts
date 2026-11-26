import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { resolveExecutable } from '../../run/tool-path.js';
import { antigravityBucketIdentity, antigravityGroupName, antigravityResetTime } from '../../usage/resource-live/antigravity-quota.js';
import type { AntigravityExecutionContext, AntigravityUsageGroup, ResourceLiveReason } from '../../usage/resource-live/types.js';

export const ANTIGRAVITY_USAGE_TIMEOUT_MS = 30_000;
const exec = promisify(execFile);
export const DEFAULT_ANTIGRAVITY_MODEL = 'gemini-4-neon';
const usageSchema = z.object({
  status: z.literal('SUCCESS'),
  num_turns: z.literal(0),
  usage: z.object({
    total_tokens: z.literal(0),
    input_tokens: z.literal(0).optional(),
    output_tokens: z.literal(0).optional(),
  }),
  command: z.object({ name: z.literal('usage'), data: z.object({
    groups: z.array(z.object({ name: antigravityGroupName, description: z.string().max(4096).optional(), buckets: z.array(z.object({
      ...antigravityBucketIdentity, remaining_fraction: z.number(), reset_time: antigravityResetTime,
    })).min(1).max(32) })).min(1).max(32),
  }) }),
});

type UsageResult = ({ groups: AntigravityUsageGroup[]; reason: null } |
  { groups: null; reason: ResourceLiveReason }) & { execution_context: AntigravityExecutionContext };
type UsageDeps = { resolve?: typeof resolveExecutable; context?: typeof executionContext;
  run?: (path: string, args: string[], options: ExecFileOptionsWithStringEncoding) => Promise<{ stdout: string }> };

async function executionContext(): Promise<AntigravityExecutionContext> {
  if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY) return 'ssh';
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await exec('/bin/launchctl', ['managername'], {
        timeout: 1_000, killSignal: 'SIGKILL', encoding: 'utf8', shell: false, maxBuffer: 1024,
      });
      if (stdout.trim() === 'Aqua') return 'gui-resident';
    } catch { /* Unproven login context is not a GUI session. */ }
  }
  return 'unknown';
}

const baseModel = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/-$/, '').replace(/-(?:low|medium|high|xhigh)$/, '');

export async function readAntigravityUsage(expectedModel = DEFAULT_ANTIGRAVITY_MODEL, deps: UsageDeps = {}): Promise<UsageResult> {
  const execution_context = await (deps.context ?? executionContext)().catch(() => 'unknown' as const);
  const unknown = (reason: ResourceLiveReason): UsageResult => ({ groups: null, reason, execution_context });
  if (execution_context !== 'gui-resident') return unknown('non_gui_context');
  try {
    const executable = (deps.resolve ?? resolveExecutable)('agy');
    if (!executable) return unknown('no-supported-source');
    const { stdout } = await (deps.run ?? exec)(executable.path, ['-p', '/usage', '--output-format', 'json'], {
      timeout: ANTIGRAVITY_USAGE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
      encoding: 'utf8', shell: false, windowsHide: true,
    });
    try {
      const parsed = usageSchema.safeParse(JSON.parse(stdout));
      if (!parsed.success) return unknown('invalid-reading');
      const groups = parsed.data.command.data.groups;
      const matches = groups.some(({ description }) => {
        const list = /^Models within this group:\s*(.+)$/i.exec(description ?? '')?.[1];
        return list?.split(',').some(model => baseModel(model) === baseModel(expectedModel));
      });
      if (!matches) return unknown('identity_mismatch');
      return { reason: null, execution_context, groups: groups.map(({ name, buckets }) => ({
        name, buckets: buckets.map(({ id, window, remaining_fraction, reset_time }) => ({
          id, window, remaining: Math.max(0, Math.min(1, remaining_fraction)),
          reset_at: reset_time,
        })),
      })) };
    } catch {
      return unknown('invalid-reading');
    }
  } catch (error) {
    const failure = error as { killed?: boolean; signal?: string } | null;
    return unknown(failure?.killed && failure.signal === 'SIGKILL' ? 'source-timeout' : 'source-error');
  }
}
