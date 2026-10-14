import { beforeEach, describe, expect, it } from 'vitest';
import type { AshlrConfig, EngineCommand } from '../src/core/types.js';
import { daemonCashBudget, daemonFundingMode, daemonFundingLabel, includedWorkFundingDefaults } from '../src/core/daemon/funding.js';
import { __resetLocalOnlyLatchForTests, enginePermitted, nativeIncludedCandidatePermitted, endpointPermitted, providerPermitted, binPermitted, filterPermittedEngines } from '../src/core/policy/local-only.js';
import { issueIncludedNativeContact, includedNativeContactCurrent } from '../src/core/run/included-native-contact.js';

const selected = { daemon: includedWorkFundingDefaults() } as AshlrConfig;
beforeEach(() => __resetLocalOnlyLatchForTests());
describe('explicit cash refusal and included native contact proof', () => {
  it('preserves absent/explicit legacy ceilings and zero pause; never treats an invalid mode as legacy', () => {
    expect(daemonFundingMode()).toBe('legacy-usd');
    expect(daemonCashBudget({ dailyBudgetUsd: 50 }, 1)).toBe(50);
    expect(daemonCashBudget({ dailyBudgetUsd: 0 }, 1)).toBe(0);
    expect(daemonCashBudget({ fundingMode: 'no-paid-cash', dailyBudgetUsd: 50 }, 1)).toBe(0);
    expect(() => daemonFundingMode({ fundingMode: 'gifted' } as never)).toThrow();
    expect(daemonFundingLabel(selected.daemon, 1)).toContain('requires current account and billing proof');
  });
  it.each(['https://api.openai.com', 'https://api.anthropic.com', 'https://api.x.ai', 'not-a-url'])('refuses paid/unknown transport %s even with a legacy positive stored ceiling', endpoint => {
    const cfg = { ...selected, daemon: { fundingMode: 'no-paid-cash', dailyBudgetUsd: 50 } } as AshlrConfig;
    expect(endpointPermitted(endpoint, cfg).permitted).toBe(false);
    expect(endpointPermitted(endpoint).permitted).toBe(false);
  });
  it('keeps provider and binary fallbacks denied while candidate selection cannot manufacture contact proof', () => {
    expect(providerPermitted('anthropic', selected).permitted).toBe(false);
    expect(binPermitted('/unknown/custom-launcher', selected).permitted).toBe(false);
    expect(enginePermitted('codex', selected).permitted).toBe(false);
    expect(nativeIncludedCandidatePermitted('codex', selected).permitted).toBe(true);
    expect(nativeIncludedCandidatePermitted('grok-cli', selected).permitted).toBe(false);
    expect(filterPermittedEngines(['codex', 'ashlrcode', 'grok-cli'], selected)).toEqual(['codex']);
    const override = { ...selected, foundry: { engines: { codex: { kind: 'cli-agent', bin: 'custom' } } } } as unknown as AshlrConfig;
    expect(nativeIncludedCandidatePermitted('codex', override).permitted).toBe(false);
  });
  it('cash refusal stays monotonic even with an explicitly legacy captured config until a fresh process', () => {
    expect(enginePermitted('codex', selected).permitted).toBe(false);
    const legacy = { daemon: { fundingMode: 'legacy-usd', dailyBudgetUsd: 50 } } as AshlrConfig;
    expect(enginePermitted('codex', legacy).permitted).toBe(false);
    expect(providerPermitted('anthropic', legacy).permitted).toBe(false);
    expect(endpointPermitted('https://api.openai.com', legacy).permitted).toBe(false);
    __resetLocalOnlyLatchForTests(); // Models a new process only; production has no reset call.
    expect(enginePermitted('codex', legacy).permitted).toBe(true);
  });

  it('binds an opaque contact proof to the exact host command and current billing closure', () => {
    let current = true;
    const command: EngineCommand = { bin: '/pinned/codex', args: ['exec','-'], cwd: '/assigned' };
    const proof = issueIncludedNativeContact('codex', command, () => current);
    expect(includedNativeContactCurrent({}, 'codex', command)).toBe(false);
    expect(includedNativeContactCurrent(proof, 'claude', command)).toBe(false);
    expect(includedNativeContactCurrent(proof, 'codex', { ...command, args: ['paid-fallback'] })).toBe(false);
    expect(includedNativeContactCurrent(proof, 'codex', command)).toBe(true);
    current = false;
    expect(includedNativeContactCurrent(proof, 'codex', command)).toBe(false);
  });
  it('local-only remains an independent stricter refusal', () => {
    expect(nativeIncludedCandidatePermitted('codex', { ...selected, foundry: { localOnly: true } } as AshlrConfig).permitted).toBe(false);
    expect(endpointPermitted('http://127.0.0.1:8080', selected).permitted).toBe(true);
  });
});
