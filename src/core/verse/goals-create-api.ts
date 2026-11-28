/**
 * Goals create API — POST /api/verse/goals lets Mason add a goal from the
 * desktop Goals pane without leaving for a terminal (RQ-PHX-GOALADDDESK92).
 * Mounted by verse-api.ts as the 'goals' workbench family (workbench-types.ts
 * §9); the pane's list read stays on V2's GET /api/goals, so a new goal shows
 * up on the next refetch. The Leader and goal loop pick it up like any goal
 * the CLI made.
 *
 * This file is the HTTP edge only: the request guard every Verse mutation
 * carries (dispatch + mutation token + JSON Content-Type + 64 KB body cap,
 * shared via api-http.ts), objective validation, then ONE
 * call into goals/store.ts createGoalIfAbsent — atomic, and it never replaces
 * an existing deterministic id. No other write can be reached from this
 * route; project enrollment stays a CLI concern, so no project is taken here.
 */
import { readMutationBody, sendInvalid } from './api-http.js';
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api-http-helpers.js';
import { createGoalIfAbsent, type CreateGoalIfAbsentResult } from '../goals/store.js';
import type { AshlrConfig } from '../types.js';

export const VERSE_GOALS_PATH = '/api/verse/goals';

/**
 * The objective limits `ashlr goals add` enforces: src/cli/goals.ts refuses a
 * missing or all-whitespace objective ('add requires an objective string.')
 * and trims before persisting. The 4000-char cap is the bound goal objectives
 * are compiled under (mission-graph.ts MAX_OBJECTIVE_LENGTH); a desktop input
 * is single-line text, so control characters are refused outright.
 */
const OBJECTIVE_MAX_CHARS = 4_000;
// Rejecting control characters is the point: an objective is one line of text.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F]/;

export interface GoalsCreateApiDeps {
  /** Store seam for tests. Default: goals/store.ts createGoalIfAbsent. */
  create?: (objective: string, opts: { cfg: AshlrConfig }) => CreateGoalIfAbsentResult;
}

export function createGoalsCreateApi(deps: GoalsCreateApiDeps = {}): ApiModule {
  const create = deps.create ?? createGoalIfAbsent;
  return async (ctx, req, res, path, method) => {
    if (path !== VERSE_GOALS_PATH) return false;
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const body = await readMutationBody(ctx, req, res);
    if (!body) return true;
    // Strict body (the V3.9 posture): only `objective` may be sent — a
    // `project` field would otherwise be silently ignored, and enrollment is
    // the CLI's check to make.
    if (Object.keys(body).some((key) => key !== 'objective')) {
      sendInvalid(res, 'body accepts only: objective');
      return true;
    }
    const raw = body['objective'];
    const objective = typeof raw === 'string' ? raw.trim() : '';
    if (objective.length === 0) {
      sendInvalid(res, 'add requires an objective string.');
      return true;
    }
    if (objective.length > OBJECTIVE_MAX_CHARS) {
      sendInvalid(res, `an objective is at most ${OBJECTIVE_MAX_CHARS} characters.`);
      return true;
    }
    if (CONTROL_CHAR_RE.test(objective)) {
      sendInvalid(res, 'an objective cannot contain control characters.');
      return true;
    }
    try {
      const result = create(objective, { cfg: ctx.cfg });
      if (result.status === 'failed') {
        sendJson(res, 500, { code: 'goal-create-failed', error: 'the goal could not be saved.' });
        return true;
      }
      const { id, objective: text, status } = result.goal;
      sendJson(res, 200, { schema: 'verse.goal-create.v1', status: result.status, goal: { id, objective: text, status } });
    } catch {
      sendJson(res, 500, { code: 'goal-create-failed', error: 'the goal could not be saved.' });
    }
    return true;
  };
}

export const handleGoalsCreateApi: ApiModule = createGoalsCreateApi();
