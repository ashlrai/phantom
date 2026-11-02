import { describe, expect, it } from 'vitest';
import { attachNotificationClick, notificationClickTarget, type NotificationClickEnv } from './desktop-notification-click.js';

const ORIGIN = 'https://console.example.com';

describe('notificationClickTarget', () => {
  it('prefers actionRun over any actionHref', () => {
    expect(notificationClickTarget({ actionRun: () => undefined, actionHref: '/verse/fleet' }, ORIGIN))
      .toEqual({ kind: 'run' });
  });

  it('maps a hash-router path to a hash target', () => {
    expect(notificationClickTarget({ actionHref: '/verse/fleet' }, ORIGIN))
      .toEqual({ kind: 'hash', hash: '#/verse/fleet' });
  });

  it('maps a same-origin absolute http(s) href to a url target', () => {
    const href = 'https://console.example.com/verse/fleet?tab=workers';
    expect(notificationClickTarget({ actionHref: href }, ORIGIN))
      .toEqual({ kind: 'url', url: href });
  });

  it('falls back to the panel for a foreign origin', () => {
    expect(notificationClickTarget({ actionHref: 'https://other.example.com/verse/fleet' }, ORIGIN))
      .toEqual({ kind: 'panel' });
  });

  it('falls back to the panel for a non-http(s) scheme', () => {
    expect(notificationClickTarget({ actionHref: 'javascript:alert(1)' }, ORIGIN))
      .toEqual({ kind: 'panel' });
    expect(notificationClickTarget({ actionHref: 'file:///etc/passwd' }, ORIGIN))
      .toEqual({ kind: 'panel' });
  });

  it('falls back to the panel when there is no action', () => {
    expect(notificationClickTarget({}, ORIGIN)).toEqual({ kind: 'panel' });
  });
});

function fakeNotification() {
  const calls: string[] = [];
  const notification = {
    onclick: null as ((this: Notification, ev: Event) => unknown) | null,
    close: () => { calls.push('close'); },
  };
  const click = () => {
    const handler = notification.onclick as unknown as (ev: Event) => unknown;
    handler(new Event('click'));
  };
  return { notification, calls, click };
}

function fakeEnv() {
  const calls: string[] = [];
  const env: NotificationClickEnv = {
    focus: () => { calls.push('focus'); },
    setHash: (hash: string) => { calls.push(`setHash:${hash}`); },
    assign: (url: string) => { calls.push(`assign:${url}`); },
    openPanel: () => { calls.push('openPanel'); },
    run: () => { calls.push('run'); },
  };
  return { calls, env };
}

describe('attachNotificationClick', () => {
  it('focuses first, runs the action, then closes for a run target', () => {
    const { notification, calls, click } = fakeNotification();
    const { calls: envCalls, env } = fakeEnv();
    attachNotificationClick(notification, { kind: 'run' }, env);
    click();
    expect(envCalls).toEqual(['focus', 'run']);
    expect(calls).toEqual(['close']);
  });

  it('sets the location hash for a hash target', () => {
    const { notification, click } = fakeNotification();
    const { calls, env } = fakeEnv();
    attachNotificationClick(notification, { kind: 'hash', hash: '#/verse/fleet' }, env);
    click();
    expect(calls).toEqual(['focus', 'setHash:#/verse/fleet']);
  });

  it('assigns the url for a url target', () => {
    const { notification, click } = fakeNotification();
    const { calls, env } = fakeEnv();
    attachNotificationClick(notification, { kind: 'url', url: 'https://console.example.com/verse/fleet' }, env);
    click();
    expect(calls).toEqual(['focus', 'assign:https://console.example.com/verse/fleet']);
  });

  it('opens the bell panel for a panel target', () => {
    const { notification, click } = fakeNotification();
    const { calls, env } = fakeEnv();
    attachNotificationClick(notification, { kind: 'panel' }, env);
    click();
    expect(calls).toEqual(['focus', 'openPanel']);
  });

  it('still closes when env.run is absent for a run target', () => {
    const { notification, calls, click } = fakeNotification();
    const { calls: envCalls, env } = fakeEnv();
    delete env.run;
    attachNotificationClick(notification, { kind: 'run' }, env);
    click();
    expect(envCalls).toEqual(['focus']);
    expect(calls).toEqual(['close']);
  });
});
