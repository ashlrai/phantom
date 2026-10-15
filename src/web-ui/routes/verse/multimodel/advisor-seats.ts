/** Pure browser projection of actual catalog options onto one real account.
 * No React, account reads, model calls, grants or defaults are changed here. */
import { capacityFromSeat } from '../../../../core/routing/headroom.js';
import { seatTier } from '../../../../core/routing/tiers.js';
import { budgetFor, canonicalModelId } from '../../../../core/verse/context-math.js';
import type { AdvisorModelVariant, AdvisorSeat } from '../../../../core/verse/multimodel/advisor.js';
import type { LocalModelBadge } from '../../../../core/verse/multimodel/types.js';
import type { VersePreferences, VerseSeat, VerseSession } from '../../../../core/verse/types.js';
import { sessionContextBudget } from '../verse-model.js';

export interface AdvisorProjectionOptions {
  session?: VerseSession | null;
  preferences?: VersePreferences | null;
}

function positive(value: number | null | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function toAdvisorSeats(
  seats: readonly VerseSeat[],
  badges?: readonly LocalModelBadge[],
  options: AdvisorProjectionOptions = {},
): AdvisorSeat[] {
  return seats.flatMap((seat) => {
    if (seat.health.state === 'unavailable') return [];
    const models = seat.models.filter((model) => !model.unavailableReason?.trim());
    if (!models.length) return [];
    const current = options.session?.seatId === seat.id ? options.session : null;
    const preferred = options.preferences?.seats[seat.id]?.contextMode ?? 'standard';
    const variants: AdvisorModelVariant[] = models.map((model) => {
      const matching = current && canonicalModelId(model.id) === canonicalModelId(current.model);
      const desiredMode = matching ? current.contextMode ?? 'standard' : preferred;
      const contextMode = matching ? desiredMode : desiredMode === 'expansive' && budgetFor(model, desiredMode) !== null ? desiredMode : 'standard';
      const catalog = budgetFor(model, contextMode);
      // Existing session evidence beats this option's catalog, including a
      // native clamp or a local window actually passed to the CLI. The meter's
      // last seat-default fallback is deliberately not exact model evidence.
      const recorded = matching && (catalog !== null || positive(current.usage.contextWindow))
        ? sessionContextBudget([seat], current) : null;
      return { model: model.id, contextMode, contextWindow: recorded?.contextWindow ?? catalog?.contextWindow ?? null,
        tier: seatTier(seat.engine, model.id) };
    });
    const first = variants.find((v) => current && canonicalModelId(v.model) === canonicalModelId(current.model)) ?? variants[0]!;
    const badge = badges?.find((b) => b.seatId === seat.id);
    return [{ seatId: seat.id, engine: seat.engine, label: seat.label, model: first.model, contextMode: first.contextMode,
      modelVariants: variants, local: seat.engine === 'local', private: seat.engine === 'local' && badge?.private === true,
      supportsTools: badge?.supportsTools ?? null,
      capacity: { ...capacityFromSeat(seat, undefined, first.model), contextWindow: first.contextWindow },
    }];
  });
}
