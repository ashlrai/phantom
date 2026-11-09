/**
 * routes/verse/panes/builtin/file-browser-queries.ts — the Files pane
 * browser's side of `POST /api/verse/files/{browse,read}`
 * (core/verse/session-files.ts).
 *
 * Both are privileged reads — the server answers them only behind the
 * mutation gate — so they go through the held mutation token exactly like
 * every other Verse write (verse-queries.ts `post`): no token →
 * VerseMutationLockedError, which the caller's token gate turns into the
 * unlock dialog. `signal` reaches apiPost so a collapsed pane or a newer
 * click can cancel a read still in flight.
 */
import { apiPost } from '../../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../../data/auth-store.js';
import { VerseMutationLockedError } from '../../verse-queries.js';
import type {
  VerseFileBrowseResponse,
  VerseFileReadResponse,
} from '../../../../../core/verse/workbench-types.js';

const FILES_API = '/api/verse/files';

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<T>(path, body, token, signal);
  touchMutationHold();
  return result;
}

/** One directory of one chat root. `path` is '' (or omitted) for the root itself. */
export function browseSessionDir(
  sessionId: string,
  root: string,
  path: string,
  signal?: AbortSignal,
): Promise<VerseFileBrowseResponse> {
  return post<VerseFileBrowseResponse>(`${FILES_API}/browse`, { sessionId, root, path }, signal);
}

/** A bounded text preview of one file inside a chat root. */
export function readSessionFilePreview(
  sessionId: string,
  root: string,
  path: string,
  signal?: AbortSignal,
): Promise<VerseFileReadResponse> {
  return post<VerseFileReadResponse>(`${FILES_API}/read`, { sessionId, root, path }, signal);
}
