/** Runs only as a child of Phantom Secrets. No provider text leaves this program. */
export const DEVIN_USAGE_WORKER = String.raw`
(async () => {
  const unknown = reason => ({ status: 'unknown', reason });
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const fail = reason => { throw { reason }; };
  try {
    const key = process.env.DEVIN_API_KEY;
    if (!key || !/^cog_[A-Za-z0-9_-]{20,}$/.test(key)) return unknown('missing-key');
    const org = process.env.DEVIN_ORG_ID;
    if (!org || !/^org-[A-Za-z0-9_-]{1,128}$/.test(org)) return unknown('missing-organization');
    const now = Date.now();
    const get = async path => {
      const response = await fetch('https://api.devin.ai/v3/' + path, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      });
      if (response.status === 429) {
        const header = response.headers.get('retry-after');
        const seconds = header && /^\d+$/.test(header) ? Number(header) : NaN;
        const until = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(header || '');
        throw { reason: 'rate-limited', retryAt: Number.isFinite(until) && until <= 8640000000000000 ? until : now + 300000 };
      }
      if (response.status === 401) fail('unauthorized');
      if (response.status === 403) fail('forbidden');
      if (response.status !== 200) fail('api-unavailable');
      const text = await response.text();
      if (text.length > 1048576) fail('malformed-body');
      try { return JSON.parse(text); } catch { fail('malformed-body'); }
    };
    const list = async path => {
      const items = [];
      let cursor = null;
      const seen = new Set();
      for (let page = 0; page < 10; page++) {
        const body = await get(path + '?first=200' + (cursor ? '&after=' + encodeURIComponent(cursor) : ''));
        if (!body || !Array.isArray(body.items)) fail('malformed-body');
        items.push(...body.items);
        if (body.has_next_page === false || body.has_next_page === undefined) return items;
        if (body.has_next_page !== true || typeof body.end_cursor !== 'string' || !body.end_cursor || seen.has(body.end_cursor)) fail('malformed-body');
        cursor = body.end_cursor;
        seen.add(cursor);
      }
      fail('pagination-limit');
    };
    const cycles = await list('enterprise/consumption/cycles');
    if (cycles.some(c => !c || !Number.isSafeInteger(c.after) || !Number.isSafeInteger(c.before) || c.after < 0 || c.before <= c.after || c.before > 8640000000000)) fail('malformed-body');
    const current = cycles.filter(c => c.after * 1000 <= now && now < c.before * 1000);
    if (current.length !== 1) fail('unknown-cycle');
    const cycle = current[0];
    const limits = await list('enterprise/consumption/acu-limits/devin');
    const matching = limits.filter(l => l && l.scope === 'org' && l.org_id === org);
    if (matching.length !== 1 || !Number.isSafeInteger(matching[0].cycle_acu_limit) || matching[0].cycle_acu_limit < 0) fail('unknown-limit');
    const body = await get('organizations/' + encodeURIComponent(org) + '/consumption/daily?time_after=' + cycle.after + '&time_before=' + cycle.before);
    if (!body || !number(body.total_acus) || !Array.isArray(body.consumption_by_date)) fail('malformed-body');
    // The limit is for Devin, not the aggregate of Devin and other products.
    let acuUsed = 0;
    const dates = new Set();
    for (const day of body.consumption_by_date) {
      if (!day || !Number.isSafeInteger(day.date) || dates.has(day.date) || !number(day.acus) || !day.acus_by_product || !number(day.acus_by_product.devin)) fail('malformed-body');
      dates.add(day.date);
      acuUsed += day.acus_by_product.devin;
    }
    if (!number(acuUsed) || acuUsed > body.total_acus || (body.total_acus > 0 && dates.size === 0)) fail('malformed-body');
    const acuLimit = matching[0].cycle_acu_limit;
    const pctUsed = acuLimit === 0 ? null : acuUsed / acuLimit * 100;
    if (pctUsed !== null && !number(pctUsed)) fail('malformed-body');
    return { pool: 'devin', acuUsed, acuLimit, pctUsed, resetAt: new Date(cycle.before * 1000).toISOString(), source: 'devin-api-v3-org-cycle', fetchedAt: new Date(now).toISOString() };
  } catch (error) {
    const reasons = ['rate-limited', 'unauthorized', 'forbidden', 'api-unavailable', 'malformed-body', 'pagination-limit', 'unknown-cycle', 'unknown-limit'];
    return { ...unknown(reasons.includes(error?.reason) ? error.reason : 'api-unreachable'), ...(error?.reason === 'rate-limited' ? { retryAt: error.retryAt } : {}) };
  }
})().then(value => process.stdout.write(JSON.stringify(value))).catch(() => process.stdout.write(JSON.stringify({ status: 'unknown', reason: 'api-unreachable' })));
`;
