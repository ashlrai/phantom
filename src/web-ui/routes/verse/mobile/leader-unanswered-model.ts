import { buildSteering, orderAge, unansweredOrders } from '../fleet-steering/steering-model.js';

/** The oldest unanswered orders, with the full text preserved for a follow-up. */
export function unansweredRows(runs: unknown, nowMs: number): { at: string; age: string; text: string; askAgain: string }[] {
  return unansweredOrders(buildSteering(runs), nowMs, 30).slice(0, 5).map((order) => {
    const age = orderAge(order.ageMinutes);
    return { at: order.at, age, text: order.text.slice(0, 100), askAgain: `Still unanswered after ${age}: ${order.text}` };
  });
}
