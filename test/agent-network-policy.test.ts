import { describe, expect, it } from 'vitest';
import { checkSendPolicy, parseCommsConfirmation, parseTeamIdentities, shouldIngestFromBridge } from '../src/core/agents/channel-policy.js';

const teamIdentities = parseTeamIdentities('[team]\nidentities = [{ channel = "slack", id = "U-team" }]');
const request = { channel: 'slack' as const, recipients: ['U-team'], teamIdentities, external: false, confirmedByMason: true };

describe('channel send policy', () => {
  it('allows only known recipients after confirmation', () => {
    expect(checkSendPolicy(request).status).toBe('sent');
    expect(checkSendPolicy({ ...request, confirmedByMason: false }).status).toBe('drafted');
    expect(checkSendPolicy({ ...request, recipients: ['U-other'] }).status).toBe('refused');
    expect(checkSendPolicy({ ...request, recipients: [] }).status).toBe('refused');
    expect(checkSendPolicy({ ...request, recipients: ['U-team', 'U-other'] }).status).toBe('refused');
    expect(checkSendPolicy({ ...request, external: true }).status).toBe('refused');
    expect(checkSendPolicy({ ...request, channel: 'telegram' }).status).toBe('refused');
  });
  it('fails closed for malformed config and non-boolean approval', () => {
    expect(parseTeamIdentities('invalid = [')).toEqual([]);
    expect(parseTeamIdentities('[team]\nidentities = [{ channel = "slack", id = "U-team", extra = true }]')).toEqual([]);
    expect(parseCommsConfirmation('confirmedByMason = true')).toBe(true);
    expect(parseCommsConfirmation('confirmedByMason = "true"')).toBe(false);
    expect(parseCommsConfirmation('invalid = [')).toBe(false);
  });
  it('does not re-ingest its own bridge post', () => {
    expect(shouldIngestFromBridge({ origin_bridge: 'bridge-a' }, 'bridge-a')).toBe(false);
    expect(shouldIngestFromBridge({ origin_bridge: 'bridge-a' }, 'bridge-b')).toBe(true);
    expect(shouldIngestFromBridge({}, 'bridge-a')).toBe(true);
    expect(shouldIngestFromBridge({}, '')).toBe(false);
  });
});
