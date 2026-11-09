import { describe, expect, it } from 'vitest';
import { classifyIntentByRules } from '../src/core/vision/leader-intent.js';

describe('status intent with a leading address word', () => {
  it.each(['Phantom status', 'phantom: status?', 'Leader, sitrep', 'LEADER status!', 'phantom /status'])('%s is status', text => {
    expect(classifyIntentByRules(text).kind).toBe('status');
  });
  it.each(['status', '/status', 'sitrep?', "what's up"])('bare %s stays status', text => {
    expect(classifyIntentByRules(text).kind).toBe('status');
  });
  it('does not treat a longer sentence as status', () => {
    expect(classifyIntentByRules('phantom status page is broken, fix it').kind).not.toBe('status');
    expect(classifyIntentByRules('phantom phantom status').kind).not.toBe('status');
  });
});
