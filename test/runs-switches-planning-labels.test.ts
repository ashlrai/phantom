import { expect, it } from 'vitest';
import { RUNS_SWITCHES } from '../src/core/fleet/runs-switches.js';

/**
 * The planning surface is provider-agnostic: the planner runs on whichever
 * login the slate declares (Claude, Codex, Devin/SWE, Grok, Gemini, GLM,
 * local models). Switch copy shown to people must never name a provider —
 * names belong to lanes, engines and drop folders, which stay data.
 */
const PROVIDER_NAME = /\b(claude|anthropic|opus|fable|sonnet|sol|codex|openai|gpt|grok|xai|gemini|google|glm|zhipu|devin|swe|qwen|kimi|nim)\b/i;

it('planning switch effects never name a provider', () => {
  for (const row of RUNS_SWITCHES) {
    expect(row.effect, `${row.id} effect names a provider`).not.toMatch(PROVIDER_NAME);
  }
});

it('the planning switches still describe planning passes and the Leader loop', () => {
  const orch = RUNS_SWITCHES.find((row) => row.id === 'ORCH_OFF');
  const leader = RUNS_SWITCHES.find((row) => row.id === 'OPUS_LEADER_OFF');
  expect(orch?.effect).toContain('planning passes');
  expect(leader?.effect).toContain('Leader planning loop');
  expect(leader?.effect).toContain('any available provider');
});
