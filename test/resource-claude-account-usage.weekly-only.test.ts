/** Pure parser fixtures: no processes, network, or provider credentials. */
import { describe, expect, it } from 'vitest';
import { parseClaudeNativeUsage, parseClaudeNativeUsageStream } from '../src/core/resources/claude-account-usage.js';

const INTRO = 'You are currently using your subscription to power your Claude Code usage';
const OBSERVED = '2026-10-31T12:00:00.000Z';
const WEEK_RESET = '2026-11-04T12:00:00.000Z';
const SESSION_RESET = '2026-10-31T15:00:00.000Z';
const envelope = (lines: string[]) => ({
  type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, duration_api_ms: 0,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: {}, result: `${INTRO}\n${lines.join('\n')}`,
});
const weekly = { kind: 'weekly_all', group: 'weekly', percent: 63, resets_at: WEEK_RESET,
  is_active: false, severity: 'normal' };
const session = { kind: 'session', group: 'session', percent: 12, resets_at: SESSION_RESET,
  is_active: true, severity: 'normal' };
const stream = (limits: unknown[]) => [
  { type: 'system', subtype: 'init', session_id: 'fixture-session', uuid: 'init' },
  { type: 'assistant', session_id: 'fixture-session', uuid: 'assistant', parent_tool_use_id: null,
    usage_report: { session: { total_cost_usd: 0, total_api_duration_ms: 0, model_usage: {} },
      rate_limits: { limits, extra_usage: { is_enabled: false } } } },
  { ...envelope([]), session_id: 'fixture-session', uuid: 'result', num_turns: 0 },
].map((frame) => JSON.stringify(frame)).join('\n');
const textWindow = { id: 'seven_day', usedPercent: 63, resetsAt: null,
  nativeReport: { source: 'claude-usage', resetDescription: 'Nov 4' } };
const nativeWindow = { id: 'seven_day', usedPercent: 63, resetsAt: WEEK_RESET,
  nativeReport: { source: 'claude-usage-structured', resetDescription: null } };
const WEEK_LINE = 'Current week (all models): 63% used · resets Nov 4';

describe('Claude weekly-only usage after the Oct 31 session limit removal', () => {
  it('accepts the complete weekly-only text without inventing a session window or timestamp', () => {
    expect(parseClaudeNativeUsage(JSON.stringify(envelope([WEEK_LINE])))).toEqual([textWindow]);
  });
  it('accepts the current weekly-only native report with freshness and billing control', () => {
    expect(parseClaudeNativeUsageStream(stream([weekly]), OBSERVED)).toEqual({
      windows: [nativeWindow], quotaFresh: true, extraUsageEnabled: false,
    });
  });
  it('preserves both reported windows and the session reset provenance', () => {
    expect(parseClaudeNativeUsage(JSON.stringify(envelope(['Current session: 12% used', WEEK_LINE])))).toEqual([
      { id: 'five_hour', usedPercent: 12, resetsAt: null,
        nativeReport: { source: 'claude-usage', resetDescription: null } }, textWindow,
    ]);
    expect(parseClaudeNativeUsageStream(stream([session, weekly]), OBSERVED)).toEqual({
      windows: [{ id: 'five_hour', usedPercent: 12, resetsAt: SESSION_RESET,
        nativeReport: { source: 'claude-usage-structured', resetDescription: null },
        resetProvenance: { kind: 'rolling-release', at: SESSION_RESET, source: 'claude-native-usage-report',
          description: 'Provider-reported five-hour recovery; not fixed weekly expiry.' } }, nativeWindow],
      quotaFresh: true, extraUsageEnabled: false,
    });
  });
  it.each([{ lines: ['Current session: 12% used'] }, { lines: [] }])('rejects text without the all-model weekly window (%j)', ({ lines }) => {
    expect(parseClaudeNativeUsage(JSON.stringify(envelope(lines)))).toBeNull();
  });
  it.each([{ rows: [session] }, { rows: [] }])('rejects native reports without the all-model weekly window (%j)', ({ rows }) => {
    expect(parseClaudeNativeUsageStream(stream(rows), OBSERVED)).toBeNull();
  });
  it.each(['101', '-1', 'NaN', '1.5'])('still rejects malformed text percentages %s', (percent) => {
    expect(parseClaudeNativeUsage(JSON.stringify(envelope([WEEK_LINE.replace('63%', `${percent}%`)])))).toBeNull();
  });
  it.each([101, -1, '63', null])('still rejects malformed native percentages %j', (percent) => {
    expect(parseClaudeNativeUsageStream(stream([{ ...weekly, percent }]), OBSERVED)).toBeNull();
  });
  it('still rejects unknown titles, native meters and malformed reset text', () => {
    expect(parseClaudeNativeUsage(JSON.stringify(envelope([WEEK_LINE, 'Current mystery: 1% used'])))).toBeNull();
    expect(parseClaudeNativeUsageStream(stream([weekly, { ...session, kind: 'unknown' }]), OBSERVED)).toBeNull();
    expect(parseClaudeNativeUsage(JSON.stringify(envelope([WEEK_LINE.replace('Nov 4', 'Nov 44')])))).toBeNull();
  });
  it.each(['Fable', 'Opus', 'Sonnet'])('preserves model-specific weekly windows without a session (%s)', (model) => {
    expect(parseClaudeNativeUsage(JSON.stringify(envelope([WEEK_LINE, `Current week (${model}): 2% used`]))))
      .toEqual([textWindow, { id: `seven_day_${model.toLowerCase()}`, usedPercent: 2, resetsAt: null,
        nativeReport: { source: 'claude-usage', resetDescription: null } }]);
    expect(parseClaudeNativeUsageStream(stream([weekly, { ...weekly, kind: 'weekly_scoped', percent: 2,
      scope: { model: { display_name: model }, surface: null } }]), OBSERVED)?.windows)
      .toEqual([nativeWindow, { ...nativeWindow, id: `seven_day_${model.toLowerCase()}`, usedPercent: 2 }]);
  });
});
