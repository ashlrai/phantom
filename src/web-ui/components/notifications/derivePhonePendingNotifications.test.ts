import { describe, expect, it, vi } from 'vitest';
import { setVerseSection } from '../../routes/verse/verse-ui-store.js';
import { derivePhonePendingNotifications as derive } from './derivePhonePendingNotifications.js';

vi.mock('../../routes/verse/verse-ui-store.js', () => ({ setVerseSection: vi.fn() }));

const nowMs = Date.parse('2026-11-01T00:12:00Z');
const approval = { id: 'phone-1', label: 'My phone', email: 'person@example.test', deviceType: 'phone', subject: 'fake-credential-id' };

describe('pending phone notifications', () => {
  it('creates an action that opens the device area of Connection', () => {
    const [item] = derive({ approvals: [approval], nowMs });
    expect(item).toMatchObject({ id: 'phone-pending:phone-1', category: 'action-required', severity: 'high',
      title: 'Phone waiting for approval', detail: 'My phone (person@example.test) registered a passkey. Approve it in Settings > Connection.',
      ts: '2026-11-01T00:12:00.000Z', actionLabel: 'Open Connection' });
    item?.actionRun?.();
    expect(setVerseSection).toHaveBeenCalledWith('settings', 'fleet-sources');
  });

  it('gives three approvals distinct ids', () => {
    const approvals = ['1', '2', '3'].map((id) => ({ ...approval, id }));
    expect(derive({ approvals, nowMs }).map((item) => item.id)).toEqual(['phone-pending:1', 'phone-pending:2', 'phone-pending:3']);
  });

  it('returns nothing for an empty list', () => {
    expect(derive({ approvals: [], nowMs })).toEqual([]);
  });

  it('falls back to device type when email is missing', () => {
    const [item] = derive({ approvals: [{ id: '1', label: 'Phone', deviceType: 'iPhone' }], nowMs });
    expect(item?.detail).toContain('Phone (iPhone) registered a passkey.');
  });

  it('never renders subject in the title or body', () => {
    const [item] = derive({ approvals: [approval], nowMs });
    expect(`${item?.title} ${item?.detail}`).not.toContain(approval.subject);
  });
});
