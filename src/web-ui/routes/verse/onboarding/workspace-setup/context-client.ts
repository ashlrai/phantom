import { apiGet, apiPost, ApiError } from '../../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../../data/auth-store.js';
import { VerseMutationLockedError } from '../../verse-queries.js';
import { contextImportSelectionDigest, contextImportReference } from '../../../../../core/verse/context-import-preview.js';
import { CONTEXT_IMPORT_PATH, contextImportCanonical, validContextImportCommitResponse, validContextImportDescriptor,
  validContextImportItems, validContextImportRecord, type ContextImportItem, type ContextImportPreview, type ContextImportRecord } from '../../../../../core/verse/context-import-types.js';

export interface ContextReferenceApi {
  save(projectPath: string, preview: ContextImportPreview, items: ContextImportItem[], signal: AbortSignal): Promise<ContextImportRecord>;
}
export const contextReferenceApi: ContextReferenceApi = {
  async save(projectPath, preview, items, signal) {
    const token = getMutationToken(); if (!token) throw new VerseMutationLockedError();
    if (!validContextImportItems(items)) throw new Error('Invalid selection');
    const query = `?projectPath=${encodeURIComponent(projectPath)}`;
    const descriptor = await apiGet<unknown>(CONTEXT_IMPORT_PATH + query, signal);
    if (!validContextImportDescriptor(descriptor)) throw new Error('Invalid project binding');
    const selectionDigest = await contextImportSelectionDigest(items);
    const edited = items.some(item => contextImportCanonical(item) !== contextImportCanonical(preview.items.find(original => original.id === item.id)));
    const transformations = [...preview.transformations];
    if (edited && !transformations.includes('operator-edited')) transformations.push('operator-edited');
    const response = await apiPost<unknown>(CONTEXT_IMPORT_PATH, { schemaVersion: 1, projectPath, projectDigest: descriptor.projectDigest,
      claimedProvider: preview.claimedProvider, provenance: preview.provenance, sourceLabel: preview.sourceLabel,
      sourceDigest: preview.sourceDigest, selectionDigest, transformations, items }, token, signal);
    if (!validContextImportCommitResponse(response)) throw new Error('Invalid import receipt');
    const record = response.record;
    if (record.projectDigest !== descriptor.projectDigest || record.selectionDigest !== selectionDigest || record.sourceDigest !== preview.sourceDigest ||
      record.claimedProvider !== preview.claimedProvider || record.provenance !== preview.provenance || record.sourceLabel !== preview.sourceLabel ||
      contextImportCanonical(record.items) !== contextImportCanonical(items) || contextImportCanonical(record.transformations) !== contextImportCanonical(transformations)) throw new Error('Import receipt did not match selection');
    const readback = await apiGet<unknown>(`${CONTEXT_IMPORT_PATH}/${encodeURIComponent(record.id)}${query}`, signal);
    if (!validContextImportRecord(readback) || contextImportCanonical(readback) !== contextImportCanonical(record) ||
      await contextImportSelectionDigest(readback.items) !== selectionDigest) throw new Error('Import readback did not match selection');
    if (signal.aborted) throw signal.reason;
    touchMutationHold(); return readback;
  },
};
export function referenceSaveError(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return 'Your connection or action token expired. Reconnect and try again.';
  if (error instanceof ApiError && error.status === 404) return 'Reference imports are unavailable on this Phantom server.';
  if (error instanceof ApiError && error.status === 413) return 'The selected reference is too large. Select fewer items.';
  if (error instanceof ApiError && error.status === 400) return 'The project or selected reference could not be accepted. Check the selection and try again.';
  return 'The saved reference could not be verified. It may already be recorded; retrying the same selection is safe.';
}
export function referenceDraft(record: ContextImportRecord): string {
  return contextImportReference(record);
}
