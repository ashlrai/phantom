import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compareCheckpointReplay, MAX_CHECKPOINT_REPLAY_BYTES, runCheckpointConditionD } from '../src/core/local-eval/checkpoint-comparison.js';
import { cmdEvalCheckpoints } from '../src/cli/eval-checkpoints.js';
import { cmdEval } from '../src/cli/eval.js';

const enabled = { PHANTOM_CHECKPOINTS: '1' };
function fixture() {
  return {
    task_id: 'checkpoint-retention', objective: 'Repair the parser', system_instructions: 'Use verified observations.',
    fresh_repo_state: 'HEAD fixture-revision; working tree clean', fixed_interval: 1,
    turns: [
      { prompt: 'Inspect the parser. OLD_TRANSCRIPT_MARKER', assistant: 'Examined parser.',
        tool_event: { id: 'read-1', name: 'read_file', result: 'The parser requires a closing delimiter.' },
        fixed_summary: 'Inspected parser. ' + 'Unrelated narrative. '.repeat(100),
        checkpoint: { objective: 'Repair the parser',
          verified_facts: [{ text: 'The parser requires a closing delimiter.', evidence_ref: 'read-1' }],
          open_hypotheses: ['The lexer may also be involved.'], failed_approaches: ['Removing the delimiter failed.'],
          next_actions: ['Test the closing delimiter.'] } },
      { prompt: 'Consider the smallest change.', assistant: 'Ready to finish.',
        fixed_summary: 'Looked at a parser. ' + 'Unrelated narrative. '.repeat(100) },
      { prompt: 'Complete the repair with the known requirements.', assistant: 'The parser requires a closing delimiter.' },
    ],
    assertions: { contains: ['The parser requires a closing delimiter.', 'Removing the delimiter failed.', 'Test the closing delimiter.'],
      excludes: ['OLD_TRANSCRIPT_MARKER'] },
  };
}

describe('checkpoint comparison replay', () => {
  it('emits deterministic input counts for both strategies on the same scripted task', () => {
    const report = compareCheckpointReplay(fixture(), enabled);
    expect(report).toEqual(compareCheckpointReplay(fixture(), enabled));
    expect(report.token_basis).toBe('conservative-request-reservation-v1');
    expect(report.outcome_basis).toBe('final-request-context-assertions');
    expect(report.strategies.map(arm => arm.strategy)).toEqual(['fixed-interval', 'checkpoint-resume']);
    for (const arm of report.strategies) {
      expect(Number.isSafeInteger(arm.input_tokens)).toBe(true);
      expect(arm.input_tokens).toBeGreaterThan(0);
      expect(arm.requests).toBe(3);
    }
    expect(report.strategies[0].resets).toBe(2);
    expect(report.strategies[1].resets).toBe(1);
    expect(report.strategies[0].input_tokens).not.toBe(report.strategies[1].input_tokens);
  });

  it('computes outcome from retained context, excluding the scripted final answer', () => {
    const report = compareCheckpointReplay(fixture(), enabled);
    expect(report.strategies[0].outcome).toBe('failed');
    expect(report.strategies[1]).toMatchObject({ outcome: 'passed', assertions: { passed: 4, total: 4 } });
    const value = fixture();
    value.assertions.contains = ['Only the final scripted answer has this'];
    value.turns[2]!.assistant = value.assertions.contains[0]!;
    expect(compareCheckpointReplay(value, enabled).strategies.map(arm => arm.outcome)).toEqual(['failed', 'failed']);
  });

  it('exposes condition D without claiming provider measurements or executing tools', () => {
    expect(runCheckpointConditionD(fixture(), enabled)).toEqual({
      evaluation: 'RQ-AGL-EVAL-1', condition: 'D', comparison: compareCheckpointReplay(fixture(), enabled),
    });
    expect(JSON.stringify(runCheckpointConditionD(fixture(), enabled))).not.toContain('OLD_TRANSCRIPT_MARKER');
  });

  it.each([{}, { PHANTOM_CHECKPOINTS: '0' }, { PHANTOM_CHECKPOINTS: 'true' }])('defaults off for %j', env => {
    expect(() => compareCheckpointReplay(fixture(), env)).toThrow('PHANTOM_CHECKPOINTS=1');
  });

  it('rejects malformed, oversized and incomplete comparison fixtures', () => {
    expect(() => compareCheckpointReplay({ ...fixture(), status: 'passed' }, enabled)).toThrow('Invalid checkpoint replay fixture');
    expect(() => compareCheckpointReplay({ ...fixture(), objective: 'x'.repeat(MAX_CHECKPOINT_REPLAY_BYTES) }, enabled)).toThrow('byte limit');
    const missingSummary = fixture(); delete missingSummary.turns[0]!.fixed_summary;
    expect(() => compareCheckpointReplay(missingSummary, enabled)).toThrow('Missing fixed-interval');
    const noBoundary = fixture(); noBoundary.fixed_interval = 3;
    expect(() => compareCheckpointReplay(noBoundary, enabled)).toThrow('both strategy boundaries');
    const noCheckpoint = fixture(); delete noCheckpoint.turns[0]!.checkpoint;
    expect(() => compareCheckpointReplay(noCheckpoint, enabled)).toThrow('both strategy boundaries');
    const duplicate = fixture(); duplicate.turns[1]!.tool_event = duplicate.turns[0]!.tool_event;
    expect(() => compareCheckpointReplay(duplicate, enabled)).toThrow('Duplicate replay tool event');
  });
});

describe('eval checkpoints CLI', () => {
  function run(args: string[], value: unknown = fixture(), env: NodeJS.ProcessEnv = enabled) {
    let stdout = '', stderr = '';
    const read = vi.fn(() => value);
    const code = cmdEvalCheckpoints(args, { env, read, stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
    return { code, stdout, stderr, read };
  }

  it('emits the comparison JSON', () => {
    const result = run(['--file', 'fixture.json', '--json']);
    expect(result.code).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(compareCheckpointReplay(fixture(), enabled));
  });

  it.each([[], ['--file'], ['--file', 'fixture.json', '--bad'], ['--file', 'fixture.json', '--json', '--json']].map(args => ({ args })))(
    'rejects invalid arguments $args before reading', ({ args }) => {
      const result = run(args);
      expect(result.code).toBe(2); expect(result.read).not.toHaveBeenCalled(); expect(result.stdout).toBe('');
    });

  it('keeps disabled and malformed data out of errors', () => {
    const disabled = run(['--file', 'fixture.json'], fixture(), {});
    expect(disabled.code).toBe(2); expect(disabled.read).not.toHaveBeenCalled();
    const invalid = run(['--file', 'fixture.json'], { confidential: 'SOURCE_MARKER' });
    expect(invalid.code).toBe(2); expect(invalid.stdout).toBe(''); expect(invalid.stderr).not.toContain('SOURCE_MARKER');
  });

  it('reads a bounded private fixture from disk and refuses corrupt input', () => {
    const directory = mkdtempSync(join(tmpdir(), 'checkpoint-comparison-'));
    const path = join(directory, 'fixture.json');
    let stdout = '', stderr = '';
    try {
      writeFileSync(path, JSON.stringify(fixture()), { mode: 0o600 });
      const deps = { env: enabled, stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } };
      expect(cmdEvalCheckpoints(['--file', path], deps)).toBe(0);
      expect(JSON.parse(stdout).strategies).toHaveLength(2); expect(stderr).toBe('');
      writeFileSync(path, '{invalid SOURCE_MARKER'); stdout = '';
      expect(cmdEvalCheckpoints(['--file', path], deps)).toBe(2);
      expect(stdout).toBe(''); expect(stderr).not.toContain('SOURCE_MARKER');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('routes eval checkpoints help without loading provider configuration', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await cmdEval(['checkpoints', '--help'])).toBe(0);
      expect(write).toHaveBeenCalledWith(expect.stringContaining('Offline replay'));
    } finally { write.mockRestore(); }
  });
});
