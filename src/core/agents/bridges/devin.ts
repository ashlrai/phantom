/** Devin send bridge. REST uses the official sessions messages API. Tracked tasks use messageDevinTask. */
import { messageDevinTask } from '../../devin/service.js';
import { DEVIN_ORG_ID_PATTERN, DEVIN_SESSION_ID_PATTERN } from '../../devin/types.js';
import type { DeliverResult } from '../channel-policy.js';

export const DEVIN_MESSAGE_MAX = 4_000;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface DevinMessageClient {
  sendMessage(orgId: string, sessionId: string, message: string): Promise<void>;
}

export interface DevinTrackedSend {
  (taskId: string, text: string): Promise<{ ok: boolean }>;
}

export async function defaultTrackedDevinSend(taskId: string, text: string): Promise<{ ok: boolean }> {
  const result = await messageDevinTask(taskId, text);
  return { ok: result.ok };
}

export async function sendDevinRestMessage(client: DevinMessageClient, orgId: string, sessionId: string, text: string): Promise<void> {
  await client.sendMessage(orgId, sessionId, text);
}

function usableText(text: string): boolean {
  return typeof text === 'string' && text.trim() !== '' && text.length <= DEVIN_MESSAGE_MAX && !text.includes('\0');
}

export async function sendDevinBridge(input: {
  text: string;
  orgId?: string;
  sessionId?: string;
  taskId?: string;
  client?: DevinMessageClient;
  sendTracked?: DevinTrackedSend;
}): Promise<DeliverResult> {
  if (!usableText(input.text)) return { status: 'refused', reason: 'Devin message is empty or too long.' };
  try {
    if (input.orgId && input.sessionId && input.client) {
      if (!DEVIN_ORG_ID_PATTERN.test(input.orgId) || !DEVIN_SESSION_ID_PATTERN.test(input.sessionId)) {
        return { status: 'refused', reason: 'Devin session address is not valid.' };
      }
      await sendDevinRestMessage(input.client, input.orgId, input.sessionId, input.text);
      return { status: 'sent', reason: 'Devin session accepted the message.' };
    }
    if (input.taskId) {
      if (!TASK_ID.test(input.taskId)) return { status: 'refused', reason: 'Devin task id is not a safe label.' };
      const result = await (input.sendTracked ?? defaultTrackedDevinSend)(input.taskId, input.text);
      return result.ok
        ? { status: 'sent', reason: 'Devin tracked task accepted the message.' }
        : { status: 'refused', reason: 'Devin did not accept the message.' };
    }
    return { status: 'refused', reason: 'Devin send is not configured.' };
  } catch {
    return { status: 'refused', reason: 'Devin send failed closed.' };
  }
}
