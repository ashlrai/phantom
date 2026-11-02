// Claude Code 2.1.312 verified for the local /usage probe (see the comment above
// CLAUDE_USAGE_VERIFIED_VERSIONS). Frame shape mirrors a real 2.1.312 run; ids are fake.
import { describe, expect, it } from 'vitest';
import { CLAUDE_USAGE_VERIFIED_VERSIONS, parseClaudeNativeUsageStream } from '../src/core/resources/claude-account-usage.js';

const OBSERVED = '2026-11-02T12:00:00.000Z';
const RESET = '2026-11-06T22:59:00.000Z';
const SID = 'fake-session-0000';

const weeklyAll = { kind: 'weekly_all', group: 'weekly', percent: 12, resets_at: RESET, scope: null, severity: 'normal', is_active: false };
const weeklyFable = { kind: 'weekly_scoped', group: 'weekly', percent: 34, resets_at: RESET,
  scope: { model: { display_name: 'Fable' }, surface: null }, severity: 'normal', is_active: false };

const frames = (over: Record<string, unknown> = {}) => [
  { type: 'system', subtype: 'init', cwd: '/fake', session_id: SID, tools: [], mcp_servers: [], model: 'fake-model',
    permissionMode: 'default', slash_commands: ['usage'], apiKeySource: 'none', claude_code_version: '2.1.312',
    uuid: 'fake-uuid-init', original_cwd: '/fake', view_mode: 'default' },
  { type: 'assistant', message: { id: 'fake-msg', role: 'assistant', model: '<synthetic>', type: 'message',
      content: [{ type: 'text', text: 'fake local command output' }], usage: { input_tokens: 0, output_tokens: 0 } },
    parent_tool_use_id: null, local_command_source: '<local-command-stdout>fake</local-command-stdout>',
    session_id: SID, uuid: 'fake-uuid-assistant', timestamp: OBSERVED, local_command_run: { command: 'usage', args: '' },
    usage_report: { session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 5, model_usage: {} },
      rate_limits: { limits: [weeklyAll, weeklyFable], extra_usage: { is_enabled: false } } } },
  { type: 'result', subtype: 'success', is_error: false, duration_ms: 5, duration_api_ms: 0, num_turns: 0,
    result: 'fake', local_command: 'usage', stop_reason: null, session_id: SID, total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {}, permission_denials: [], safety_stops: 0, subagent_stats: { spawned: 0 }, queued_turn_count: 0,
    result_index: 0, model_usage_since_last_result: {}, uuid: 'fake-uuid-result', ...over },
].map((frame) => JSON.stringify(frame)).join('\n');

describe('Claude Code 2.1.312 usage pin', () => {
  it('lists 2.1.312 as verified and not the unverified 2.1.300', () => {
    expect(CLAUDE_USAGE_VERIFIED_VERSIONS).toContain('2.1.312');
    expect(CLAUDE_USAGE_VERIFIED_VERSIONS.at(-1)).toBe('2.1.312');
    expect(CLAUDE_USAGE_VERIFIED_VERSIONS).not.toContain('2.1.300');
  });

  it('parses the real frame shape into fresh weekly windows', () => {
    const parsed = parseClaudeNativeUsageStream(frames(), OBSERVED);
    expect(parsed?.quotaFresh).toBe(true);
    expect(parsed?.windows.map((window) => window.id)).toEqual(['seven_day', 'seven_day_fable']);
  });

  it('rejects a nonzero total_cost_usd', () => {
    expect(parseClaudeNativeUsageStream(frames({ total_cost_usd: 0.01 }), OBSERVED)).toBeNull();
  });

  it('rejects a nonzero num_turns', () => {
    expect(parseClaudeNativeUsageStream(frames({ num_turns: 1 }), OBSERVED)).toBeNull();
  });
});
