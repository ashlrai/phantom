import { expect, it } from 'vitest';
import { approveOutcomeText, pendingTell, readPendingPhones } from './pending-phones-model.js';

const id = '11111111-1111-1111-1111-111111111111';
const phone = { id, label: 'Phone', email: 'a@example.invalid', subject: 'private subject', deviceType: 'phone', credentialId: 'private credential' };
const snapshot = { v: 1, generatedAt: 'now', gateway: 'running', approvals: [phone] };

it('validates the envelope and each phone, bounds display strings, and drops private fields', () => {
  expect(readPendingPhones(snapshot)).toEqual([{ id, label: 'Phone', email: 'a@example.invalid', deviceType: 'phone' }]);
  expect(readPendingPhones({ ...snapshot, approvals: [{ ...phone, label: 'x'.repeat(201), email: 'y'.repeat(201), deviceType: 'z'.repeat(201) }] }))
    .toEqual([{ id, label: 'x'.repeat(200), email: 'y'.repeat(200), deviceType: 'z'.repeat(200) }]);
  for (const invalid of [null, {}, { ...snapshot, gateway: 'unknown' }, { ...snapshot, approvals: [{ ...phone, id: 'bad' }] },
    { ...snapshot, approvals: [{ ...phone, subject: null }] }, { ...snapshot, approvals: [{ ...phone, deviceType: 1 }] }]) {
    expect(readPendingPhones(invalid)).toBeNull();
  }
});

it('describes gateway and confirmed outcomes without echoing unvalidated identifiers', () => {
  expect(pendingTell(1, 'running')).toBe('1 phone awaiting approval.');
  expect(pendingTell(2, 'running')).toBe('2 phones awaiting approval.');
  expect(pendingTell(0, 'not-running')).toBe('Phone gateway is not running.');
  expect(approveOutcomeText({ approved: true, deviceId: id })).toBe(`Approved · device ${id}`);
  expect(approveOutcomeText({ denied: true })).toBe('Denied');
  expect(approveOutcomeText({ error: 'Mac operator confirmation required' })).toBe('Mac operator confirmation required');
  expect(approveOutcomeText({ approved: true, deviceId: 'secret' })).toBe('Pairing outcome could not be confirmed.');
});
