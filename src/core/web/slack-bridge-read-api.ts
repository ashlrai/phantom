/**
 * RQ-PHX-SLACKBRIDGEDESK671: read-only Slack bridge status for the desktop
 * Fleet view. A pure projection of buildSlackBridgeStatus (offline: no socket,
 * no Web API, no credential read). Drops the config path, team/user/bot ids,
 * secret reference names and channel ids; only topic names leave the host.
 * Never answers 500 and never echoes error text.
 */
import type { ServerResponse } from 'node:http';
import { buildSlackBridgeStatus, type SlackBridgeStatus, type SlackBridgeStatusOptions } from '../agents/slack-status.js';
import { sendJson } from './api-http-helpers.js';

export const SLACK_BRIDGE_READ_PATH = '/api/fleet/slack-bridge';
const UNREADABLE_NEXT = 'run phm channels slack status --json on the host';

export interface SlackBridgeView {
  v: 1;
  at: string;
  configState: string;
  slackSection: 'ok' | 'invalid' | 'absent';
  ready: boolean;
  botTokenRefSet: boolean;
  appTokenRefSet: boolean;
  topics: string[];
  slackIdentities: number;
  confirmedByMason: boolean;
  journal: { state: string; ingested: number; ignored: number; lastAt: string | null };
  transport: 'unknown';
  next: string | null;
}

export function projectSlackBridgeStatus(s: SlackBridgeStatus): SlackBridgeView {
  return {
    v: 1,
    at: s.at,
    configState: s.config.state,
    slackSection: s.slackSection,
    ready: s.ready,
    botTokenRefSet: s.credentials.botTokenRef !== null,
    appTokenRefSet: s.credentials.appTokenRef !== null,
    topics: [...new Set(s.mappings.map((m) => m.topic))].sort(),
    slackIdentities: s.teamIdentities.slack,
    confirmedByMason: s.comms.confirmedByMason,
    journal: { state: s.journal.state, ingested: s.journal.ingested, ignored: s.journal.ignored, lastAt: s.journal.lastAt },
    transport: 'unknown',
    next: s.next ?? null,
  };
}

export function handleSlackBridgeRead(res: ServerResponse, options?: SlackBridgeStatusOptions): void {
  let view: SlackBridgeView;
  try {
    view = projectSlackBridgeStatus(buildSlackBridgeStatus(options));
  } catch {
    view = {
      v: 1, at: new Date().toISOString(), configState: 'unreadable', slackSection: 'absent', ready: false,
      botTokenRefSet: false, appTokenRefSet: false, topics: [], slackIdentities: 0, confirmedByMason: false,
      journal: { state: 'unreadable', ingested: 0, ignored: 0, lastAt: null }, transport: 'unknown', next: UNREADABLE_NEXT,
    };
  }
  sendJson(res, 200, view);
}
