/** Provider send bridges. Gates run before any executor. */
import type { DeliverResult, TeamIdentity } from '../channel-policy.js';
import { outboundGate } from '../send-gate.js';
import { defaultCodexExec, sendCodexBridge, type CommandExec } from './codex.js';
import { sendDevinBridge, type DevinMessageClient, type DevinTrackedSend } from './devin.js';
import { sendClaudeBridge, sendGrokBridge } from './stubs.js';

export type BridgeProvider = 'codex' | 'devin' | 'grok' | 'claude';

export interface ProviderBridgeRequest {
  provider: BridgeProvider;
  recipientId: string;
  text: string;
  threadId?: string;
  orgId?: string;
  sessionId?: string;
  taskId?: string;
  teamIdentities: readonly TeamIdentity[];
  confirmedByMason: boolean;
  external?: boolean;
}

export interface BridgeDeps {
  exec?: CommandExec;
  client?: DevinMessageClient;
  sendTracked?: DevinTrackedSend;
}

export async function sendProviderBridge(request: ProviderBridgeRequest, deps: BridgeDeps = {}): Promise<DeliverResult> {
  const gated = outboundGate({
    channel: 'bus',
    recipientId: request.recipientId,
    text: request.text,
    teamIdentities: request.teamIdentities,
    confirmedByMason: request.confirmedByMason,
    external: request.external === true,
  });
  if (gated) return gated;
  switch (request.provider) {
    case 'codex':
      return sendCodexBridge({ threadId: request.threadId ?? '', text: request.text }, deps.exec ?? defaultCodexExec);
    case 'devin':
      return sendDevinBridge({
        text: request.text, orgId: request.orgId, sessionId: request.sessionId, taskId: request.taskId,
        client: deps.client, sendTracked: deps.sendTracked,
      });
    case 'grok':
      return sendGrokBridge();
    case 'claude':
      return sendClaudeBridge();
    default: {
      const unknown: never = request.provider;
      return { status: 'refused', reason: `No bridge is registered for ${String(unknown)}.` };
    }
  }
}
