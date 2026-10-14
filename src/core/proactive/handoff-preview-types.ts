/** Browser-safe local copy-preview contract. No field qualifies a provider connection or execution. */
export const GROK_HANDOFF_PREVIEW_MAX_BYTES = 32 * 1024;
export interface GrokHandoffPreviewRequest {
  taskId: string; attemptId: string; epoch: number; expectedRevision: number;
  profileId: string; expectedProfileVersion: number; expectedPreviewDigest?: string;
}
export interface GrokHandoffPreviewResponse {
  schemaVersion: 1; taskId: string; attemptId: string; epoch: number; revision: number;
  profileId: string; profileVersion: number; packetDigest: string; previewDigest: string; briefText: string;
  dispatchAuthorized: false; contextShared: false; transport: 'manual-copy';
}
export function validGrokHandoffPreviewRequest(value: unknown): value is GrokHandoffPreviewRequest {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = ['taskId', 'attemptId', 'epoch', 'expectedRevision', 'profileId', 'expectedProfileVersion'];
  const own = Reflect.ownKeys(value);
  if (!keys.every(key => Object.hasOwn(value, key)) || own.some(key => typeof key !== 'string'
    || ![...keys, 'expectedPreviewDigest'].includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) return false;
  const input = value as GrokHandoffPreviewRequest;
  return typeof input.taskId === 'string' && /^ct_[a-f0-9]{32}$/.test(input.taskId)
    && typeof input.attemptId === 'string' && /^[a-f0-9]{64}$/.test(input.attemptId)
    && Number.isSafeInteger(input.epoch) && input.epoch >= 1 && input.epoch <= 32
    && Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0
    && typeof input.profileId === 'string' && /^pa_[a-f0-9]{24}$/.test(input.profileId)
    && Number.isSafeInteger(input.expectedProfileVersion) && input.expectedProfileVersion >= 1
    && (!Object.hasOwn(value, 'expectedPreviewDigest') || typeof input.expectedPreviewDigest === 'string' && /^[a-f0-9]{64}$/.test(input.expectedPreviewDigest));
}
