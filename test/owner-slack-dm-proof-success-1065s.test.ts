import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { proveOwnerDirectMessage } from '../src/core/comms/owner-live-transport.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('Slack DM proof verification', () => {
  const testHome = mkdtempSync(join(tmpdir(), 'slack-proof-'));
  
  beforeEach(() => {
    vi.stubEnv('HOME', testHome);
    vi.stubEnv('ASHLR_HOME', testHome);
  });
  
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(testHome, { recursive: true, force: true });
  });

  it('should refuse proof when any API response has ok: false', async () => {
    const ref = 'slack:T123:D123:1700000000.000100';
    
    // Test with conversations.info returning ok: false (should fail)
    const callWithFalseInfo = async (method: string) => {
      if (method === 'conversations.info') return { channel: { id: 'D123', is_im: true }, ok: false };
      if (method === 'conversations.members') return { members: ['U0123456789', 'U0BOTUSER1'], ok: true };
      if (method === 'auth.test') return { user_id: 'U0BOTUSER1', bot_id: 'B0BOTUSER1', ok: true };
      return {};
    };
    expect(await proveOwnerDirectMessage(callWithFalseInfo, ref, 'U0123456789')).toBe(false);
    
    // Test with conversations.members returning ok: false (should fail)  
    const callWithFalseMembers = async (method: string) => {
      if (method === 'conversations.info') return { channel: { id: 'D123', is_im: true }, ok: true };
      if (method === 'conversations.members') return { members: ['U0123456789', 'U0BOTUSER1'], ok: false };
      if (method === 'auth.test') return { user_id: 'U0BOTUSER1', bot_id: 'B0BOTUSER1', ok: true };
      return {};
    };
    expect(await proveOwnerDirectMessage(callWithFalseMembers, ref, 'U0123456789')).toBe(false);
    
    // Test with auth.test returning ok: false (should fail)
    const callWithFalseAuth = async (method: string) => {
      if (method === 'conversations.info') return { channel: { id: 'D123', is_im: true }, ok: true };
      if (method === 'conversations.members') return { members: ['U0123456789', 'U0BOTUSER1'], ok: true };
      if (method === 'auth.test') return { user_id: 'U0BOTUSER1', bot_id: 'B0BOTUSER1', ok: false };
      return {};
    };
    expect(await proveOwnerDirectMessage(callWithFalseAuth, ref, 'U0123456789')).toBe(false);
  });

  it('should refuse proof when any API response is missing ok field', async () => {
    const ref = 'slack:T123:D123:1700000000.000100';
    
    // Test with conversations.info missing ok field (should fail)
    const callWithoutOkInfo = async (method: string) => {
      if (method === 'conversations.info') return { channel: { id: 'D123', is_im: true } };
      if (method === 'conversations.members') return { members: ['U0123456789', 'U0BOTUSER1'], ok: true };
      if (method === 'auth.test') return { user_id: 'U0BOTUSER1', bot_id: 'B0BOTUSER1', ok: true };
      return {};
    };
    expect(await proveOwnerDirectMessage(callWithoutOkInfo, ref, 'U0123456789')).toBe(false);
    
    // Test with conversations.members missing ok field (should fail)
    const callWithoutOkMembers = async (method: string) => {
      if (method === 'conversations.info') return { channel: { id: 'D123', is_im: true }, ok: true };
      if (method === 'conversations.members') return { members: ['U0123456789', 'U0BOTUSER1'] };
      if (method === 'auth.test') return { user_id: 'U0BOTUSER1', bot_id: 'B0BOTUSER1', ok: true };
      return {};
    };
    expect(await proveOwnerDirectMessage(callWithoutOkMembers, ref, 'U0123456789')).toBe(false);
    
    // Test with auth.test missing ok field (should fail)
    const callWithoutOkAuth = async (method: string) => {
      if (method === 'conversations.info') return { channel: { id: 'D123', is_im: true }, ok: true };
      if (method === 'conversations.members') return { members: ['U0123456789', 'U0BOTUSER1'], ok: true };
      if (method === 'auth.test') return { user_id: 'U0BOTUSER1', bot_id: 'B0BOTUSER1' };
      return {};
    };
    expect(await proveOwnerDirectMessage(callWithoutOkAuth, ref, 'U0123456789')).toBe(false);
  });

  it('should accept proof when all API responses have ok: true', async () => {
    const ref = 'slack:T123:D123:1700000000.000100';
    
    const callWithOk = async (method: string) => {
      if (method === 'conversations.info') return { channel: { id: 'D123', is_im: true }, ok: true };
      if (method === 'conversations.members') return { members: ['U0123456789', 'U0BOTUSER1'], ok: true };
      if (method === 'auth.test') return { user_id: 'U0BOTUSER1', bot_id: 'B0BOTUSER1', ok: true };
      return {};
    };
    expect(await proveOwnerDirectMessage(callWithOk, ref, 'U0123456789')).toBe(true);
  });
});
