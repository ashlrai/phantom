import { describe, expect, it } from 'vitest';
import { derivePhoneNeedsYou } from './phone-needs-you.js';

const approval = { id: '12345678-abcd-1234-abcd-123456789abc', label: 'Mason’s phone', email: 'mason@example.com', subject: 'subject' };
const pending = { v: 1, generatedAt: '2026-11-01T04:12:00Z', gateway: 'running', approvals: [approval] };

describe('derivePhoneNeedsYou', () => {
  it('produces one actionable item per approval', () => {
    expect(derivePhoneNeedsYou({ ...pending, approvals: [approval, { ...approval, id: 'abcdefab-abcd-1234-abcd-123456789abc' }] })).toEqual([
      { id: `phone-pending:${approval.id}`, severity: 'attention', title: 'Phone waiting for your approval',
        detail: 'Mason’s phone · mason@example.com', nextStep: 'Approve or deny it in Settings › Connection',
        target: 'settings', open: { kind: 'pane', paneId: 'settings-connection' } },
      { id: 'phone-pending:abcdefab-abcd-1234-abcd-123456789abc', severity: 'attention', title: 'Phone waiting for your approval',
        detail: 'Mason’s phone · mason@example.com', nextStep: 'Approve or deny it in Settings › Connection',
        target: 'settings', open: { kind: 'pane', paneId: 'settings-connection' } },
    ]);
  });
  it('drops malformed entries without dropping valid ones', () => {
    expect(derivePhoneNeedsYou({ ...pending, approvals: [null, { ...approval, id: '../bad' }, { ...approval, email: 4 }, approval] }))
      .toHaveLength(1);
  });
  it('ignores stopped gateways, absent routes and malformed payloads', () => {
    for (const data of [{ ...pending, gateway: 'not-running' }, { kind: 'notInBuild' }, null, { ...pending, v: 2 }]) {
      expect(derivePhoneNeedsYou(data)).toEqual([]);
    }
  });
});
